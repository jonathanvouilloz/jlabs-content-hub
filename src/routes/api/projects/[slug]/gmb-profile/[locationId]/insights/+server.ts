import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations, gmbInsightsDaily } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { syncLocationInsights, ALL_METRICS, type GmbMetric } from '$lib/server/gmb.js';
import { and, eq, gte, lte } from 'drizzle-orm';

type Period = '30d' | 'month' | 'year' | 'custom';

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

function computeRange(period: Period, start?: string | null, end?: string | null): { start: string; end: string } {
	// Les data Performance sont publiées à J-3.
	const today = new Date();
	const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));

	if (period === 'custom' && start && end) {
		return { start, end };
	}

	const endIso = endDate.toISOString().slice(0, 10);

	if (period === 'year') {
		const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
		return { start: startDate.toISOString().slice(0, 10), end: endIso };
	}

	if (period === 'month') {
		const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
		return { start: startDate.toISOString().slice(0, 10), end: endIso };
	}

	// default 30d
	const startDate = new Date(endDate);
	startDate.setUTCDate(startDate.getUTCDate() - 29);
	return { start: startDate.toISOString().slice(0, 10), end: endIso };
}

function previousPeriod(start: string, end: string): { start: string; end: string } {
	const s = new Date(start);
	const e = new Date(end);
	const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
	const prevEnd = new Date(s);
	prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
	const prevStart = new Date(prevEnd);
	prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
	return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const locationId = normalizeLocationId(event.params.locationId);

	const link = await db
		.select()
		.from(projectGmbLocations)
		.where(
			and(
				eq(projectGmbLocations.projectId, project.id),
				eq(projectGmbLocations.gmbLocationId, locationId)
			)
		)
		.then((r) => r[0]);
	if (!link) return errorResponse('Location not assigned to project', 404);

	const periodParam = (event.url.searchParams.get('period') ?? '30d') as Period;
	const startParam = event.url.searchParams.get('start');
	const endParam = event.url.searchParams.get('end');
	const refresh = event.url.searchParams.get('refresh') === '1';

	const { start, end } = computeRange(periodParam, startParam, endParam);

	// Si pas de data en DB pour la période ET qu'on est en lazy mode, déclencher un backfill
	const existingCount = await db
		.select({ id: gmbInsightsDaily.id })
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, locationId),
				gte(gmbInsightsDaily.date, start),
				lte(gmbInsightsDaily.date, end)
			)
		)
		;

	if (refresh || existingCount.length === 0) {
		const startDate = new Date(start);
		const endDate = new Date(end);
		const days = Math.max(
			30,
			Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 4
		);
		try {
			await syncLocationInsights(project.id, locationId, days);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Insights sync failed';
			return errorResponse(msg, 502);
		}
	}

	// Pull série pour la période courante
	const currentRows = await db
		.select()
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, locationId),
				gte(gmbInsightsDaily.date, start),
				lte(gmbInsightsDaily.date, end)
			)
		)
		;

	// Pull série pour période précédente (pour diff %)
	const prev = previousPeriod(start, end);
	const prevRows = await db
		.select()
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, locationId),
				gte(gmbInsightsDaily.date, prev.start),
				lte(gmbInsightsDaily.date, prev.end)
			)
		)
		;

	// Agrégats par métrique
	const aggregate = (rows: typeof currentRows) => {
		const out: Record<GmbMetric, number> = Object.fromEntries(
			ALL_METRICS.map((m) => [m, 0])
		) as Record<GmbMetric, number>;
		for (const r of rows) {
			if ((ALL_METRICS as string[]).includes(r.metric)) {
				out[r.metric as GmbMetric] += r.value;
			}
		}
		return out;
	};

	const currentTotals = aggregate(currentRows);
	const previousTotals = aggregate(prevRows);

	// Total impressions = somme des 4 channels
	const impressionsKeys: GmbMetric[] = [
		'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
		'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
		'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
		'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
	];
	const sumImpressions = (t: Record<GmbMetric, number>) =>
		impressionsKeys.reduce((acc, k) => acc + t[k], 0);

	const summary = {
		impressions: { current: sumImpressions(currentTotals), previous: sumImpressions(previousTotals) },
		websiteClicks: { current: currentTotals.WEBSITE_CLICKS, previous: previousTotals.WEBSITE_CLICKS },
		callClicks: { current: currentTotals.CALL_CLICKS, previous: previousTotals.CALL_CLICKS },
		directionRequests: {
			current: currentTotals.BUSINESS_DIRECTION_REQUESTS,
			previous: previousTotals.BUSINESS_DIRECTION_REQUESTS
		}
	};

	return jsonResponse({
		period: periodParam,
		range: { start, end },
		previousRange: prev,
		summary,
		totals: currentTotals,
		previousTotals,
		daily: currentRows.map((r) => ({ date: r.date, metric: r.metric, value: r.value }))
	});
};
