import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey, validateClientToken } from '$lib/server/api-auth.js';
import { getWatchlistWithSeries } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

const HISTORY_WEEKS = 12;

function csvCell(v: string | number | null): string {
	if (v === null) return '';
	const s = String(v);
	return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * GET — export CSV de l'évolution des positions suivies (matrice mot-clé × semaines).
 * Accessible admin, clé API, ou client via ?token= (lecture seule).
 */
export const GET: RequestHandler = async (event) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) throw error(404, 'Project not found');

	const token = event.url.searchParams.get('token');
	const viaToken = token ? (await validateClientToken(token))?.projectId === project.id : false;
	if (!event.locals.user && !validateApiKey(event) && !viaToken) {
		throw error(401, 'Unauthorized');
	}

	const entries = await getWatchlistWithSeries(project.id, HISTORY_WEEKS);
	const weeks = entries[0]?.series.map((p) => p.weekStart) ?? [];

	const header = ['mot-cle', 'cible', 'position_actuelle', 'tendance', ...weeks];
	const lines = [header.map(csvCell).join(',')];
	for (const e of entries) {
		const row: Array<string | number | null> = [
			e.keyword,
			e.targetPosition ?? '',
			e.currentPosition != null ? e.currentPosition.toFixed(1) : '',
			e.trend.verdict
		];
		for (const p of e.series) row.push(p.position != null ? p.position.toFixed(1) : '');
		lines.push(row.map(csvCell).join(','));
	}

	const csv = '﻿' + lines.join('\r\n'); // BOM pour Excel/accents
	const filename = `positions-${project.slug}-${weeks[weeks.length - 1] ?? 'export'}.csv`;
	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
};
