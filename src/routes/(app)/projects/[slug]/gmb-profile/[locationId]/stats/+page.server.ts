import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, gmbInsightsDaily } from '$lib/server/db/schema.js';
import { and, eq, gte, lte } from 'drizzle-orm';

type Period = '30d' | 'month' | 'year' | 'custom';

const IMPRESSION_METRICS = [
	'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
	'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
	'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
];

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

function computeRange(period: Period, startParam?: string | null, endParam?: string | null) {
	const today = new Date();
	const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));

	if (period === 'custom' && startParam && endParam) {
		return { start: startParam, end: endParam };
	}

	const endIso = end.toISOString().slice(0, 10);

	if (period === 'year') {
		const start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
		return { start: start.toISOString().slice(0, 10), end: endIso };
	}
	if (period === 'month') {
		const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
		return { start: start.toISOString().slice(0, 10), end: endIso };
	}
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - 29);
	return { start: start.toISOString().slice(0, 10), end: endIso };
}

function previousPeriod(start: string, end: string) {
	const s = new Date(start);
	const e = new Date(end);
	const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
	const prevEnd = new Date(s);
	prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
	const prevStart = new Date(prevEnd);
	prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
	return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

function fillSeries(rows: { date: string; metric: string; value: number }[], start: string, end: string, metrics: string[]): Array<{ date: string; value: number }> {
	const map = new Map<string, number>();
	for (const r of rows) {
		if (metrics.includes(r.metric)) map.set(r.date, (map.get(r.date) ?? 0) + r.value);
	}
	const out: Array<{ date: string; value: number }> = [];
	const cur = new Date(start);
	const endD = new Date(end);
	while (cur <= endD) {
		const iso = cur.toISOString().slice(0, 10);
		out.push({ date: iso, value: map.get(iso) ?? 0 });
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

export const load: PageServerLoad = async ({ params, url }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Projet introuvable');

	const fullLocId = normalizeLocationId(params.locationId);
	const period = (url.searchParams.get('period') ?? '30d') as Period;
	const startParam = url.searchParams.get('start');
	const endParam = url.searchParams.get('end');

	const range = computeRange(period, startParam, endParam);
	const prev = previousPeriod(range.start, range.end);

	const currentRows = await db
		.select()
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, fullLocId),
				gte(gmbInsightsDaily.date, range.start),
				lte(gmbInsightsDaily.date, range.end)
			)
		)
		;

	const prevRows = await db
		.select()
		.from(gmbInsightsDaily)
		.where(
			and(
				eq(gmbInsightsDaily.gmbLocationId, fullLocId),
				gte(gmbInsightsDaily.date, prev.start),
				lte(gmbInsightsDaily.date, prev.end)
			)
		)
		;

	const sum = (rows: typeof currentRows, metrics: string[]) =>
		rows.filter((r) => metrics.includes(r.metric)).reduce((acc, r) => acc + r.value, 0);

	const totals = {
		impressions: { current: sum(currentRows, IMPRESSION_METRICS), previous: sum(prevRows, IMPRESSION_METRICS) },
		websiteClicks: { current: sum(currentRows, ['WEBSITE_CLICKS']), previous: sum(prevRows, ['WEBSITE_CLICKS']) },
		callClicks: { current: sum(currentRows, ['CALL_CLICKS']), previous: sum(prevRows, ['CALL_CLICKS']) },
		directionRequests: {
			current: sum(currentRows, ['BUSINESS_DIRECTION_REQUESTS']),
			previous: sum(prevRows, ['BUSINESS_DIRECTION_REQUESTS'])
		}
	};

	const labels = (() => {
		const out: string[] = [];
		const cur = new Date(range.start);
		const endD = new Date(range.end);
		while (cur <= endD) {
			out.push(cur.toISOString().slice(0, 10));
			cur.setUTCDate(cur.getUTCDate() + 1);
		}
		return out;
	})();

	const impressionSeries = [
		{ label: 'Desktop Maps', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', color: '#4f46e5' },
		{ label: 'Mobile Maps', metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', color: '#7c3aed' },
		{ label: 'Desktop Search', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', color: '#0ea5e9' },
		{ label: 'Mobile Search', metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', color: '#0891b2' }
	].map((s) => ({
		label: s.label,
		color: s.color,
		points: fillSeries(currentRows, range.start, range.end, [s.metric]).map((p) => p.value)
	}));

	const actionsSeries = [
		{ label: 'Clics site', metric: 'WEBSITE_CLICKS', color: '#10b981' },
		{ label: 'Itinéraires', metric: 'BUSINESS_DIRECTION_REQUESTS', color: '#f59e0b' },
		{ label: 'Appels', metric: 'CALL_CLICKS', color: '#e11d48' }
	].map((s) => ({
		label: s.label,
		color: s.color,
		points: fillSeries(currentRows, range.start, range.end, [s.metric]).map((p) => p.value)
	}));

	return {
		period,
		range,
		previousRange: prev,
		totals,
		labels,
		impressionSeries,
		actionsSeries,
		hasInsights: currentRows.length > 0
	};
};
