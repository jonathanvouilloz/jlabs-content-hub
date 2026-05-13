import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, gmbInsightsDaily } from '$lib/server/db/schema.js';
import { and, eq, gte, lte } from 'drizzle-orm';

const IMPRESSION_METRICS = [
	'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
	'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
	'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
];

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

function rangeDaysAgo(days: number, lagDays = 3): { start: string; end: string } {
	const today = new Date();
	const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - lagDays));
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - (days - 1));
	return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function fillSeries(rows: { date: string; metric: string; value: number }[], start: string, end: string, metric: string): Array<{ date: string; value: number }> {
	const map = new Map<string, number>();
	for (const r of rows) {
		if (r.metric === metric) map.set(r.date, (map.get(r.date) ?? 0) + r.value);
	}
	const out: Array<{ date: string; value: number }> = [];
	const cur = new Date(start);
	const endDate = new Date(end);
	while (cur <= endDate) {
		const iso = cur.toISOString().slice(0, 10);
		out.push({ date: iso, value: map.get(iso) ?? 0 });
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

function fillSeriesMulti(rows: { date: string; metric: string; value: number }[], start: string, end: string, metrics: string[]): Array<{ date: string; value: number }> {
	const map = new Map<string, number>();
	for (const r of rows) {
		if (metrics.includes(r.metric)) map.set(r.date, (map.get(r.date) ?? 0) + r.value);
	}
	const out: Array<{ date: string; value: number }> = [];
	const cur = new Date(start);
	const endDate = new Date(end);
	while (cur <= endDate) {
		const iso = cur.toISOString().slice(0, 10);
		out.push({ date: iso, value: map.get(iso) ?? 0 });
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

export const load: PageServerLoad = async ({ params }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Projet introuvable');

	const fullLocId = normalizeLocationId(params.locationId);

	const current = rangeDaysAgo(30);
	const previous = rangeDaysAgo(60);
	// Period précédent = 30 j avant le current.start. previous() ci-dessus retourne 60 jours du tout.
	const prevStart = new Date(current.start);
	prevStart.setUTCDate(prevStart.getUTCDate() - 30);
	const prevEnd = new Date(current.start);
	prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
	const previousRange = {
		start: prevStart.toISOString().slice(0, 10),
		end: prevEnd.toISOString().slice(0, 10)
	};

	const allRows = await db
		.select()
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, fullLocId),
				gte(gmbInsightsDaily.date, previousRange.start),
				lte(gmbInsightsDaily.date, current.end)
			)
		)
		.all();

	const currentRows = allRows.filter((r) => r.date >= current.start && r.date <= current.end);
	const previousRows = allRows.filter((r) => r.date >= previousRange.start && r.date <= previousRange.end);

	const sum = (rows: typeof allRows, metrics: string[]) =>
		rows.filter((r) => metrics.includes(r.metric)).reduce((acc, r) => acc + r.value, 0);

	const totals = {
		impressions: { current: sum(currentRows, IMPRESSION_METRICS), previous: sum(previousRows, IMPRESSION_METRICS) },
		websiteClicks: { current: sum(currentRows, ['WEBSITE_CLICKS']), previous: sum(previousRows, ['WEBSITE_CLICKS']) },
		callClicks: { current: sum(currentRows, ['CALL_CLICKS']), previous: sum(previousRows, ['CALL_CLICKS']) },
		directionRequests: {
			current: sum(currentRows, ['BUSINESS_DIRECTION_REQUESTS']),
			previous: sum(previousRows, ['BUSINESS_DIRECTION_REQUESTS'])
		}
	};

	const sparklines = {
		impressions: fillSeriesMulti(currentRows, current.start, current.end, IMPRESSION_METRICS),
		websiteClicks: fillSeries(currentRows, current.start, current.end, 'WEBSITE_CLICKS'),
		callClicks: fillSeries(currentRows, current.start, current.end, 'CALL_CLICKS'),
		directionRequests: fillSeries(currentRows, current.start, current.end, 'BUSINESS_DIRECTION_REQUESTS')
	};

	return {
		range: current,
		previousRange,
		totals,
		sparklines,
		hasInsights: currentRows.length > 0
	};
};
