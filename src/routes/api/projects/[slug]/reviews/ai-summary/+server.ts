import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { validateApiKey, validateClientToken } from '$lib/server/api-auth.js';
import { findCachedReport, getOrGenerateReport } from '$lib/server/reviews/ai-report.js';
import type { RequestHandler } from './$types';

function parsePeriod(period: string | null): { year: number; month: number } | null {
	if (!period) return null;
	const m = period.match(/^(\d{4})-(\d{2})$/);
	if (!m) return null;
	const year = parseInt(m[1], 10);
	const month = parseInt(m[2], 10);
	if (month < 1 || month > 12) return null;
	return { year, month };
}

async function authorize(event: Parameters<RequestHandler>[0]): Promise<{ ok: true; canForce: boolean } | { ok: false; status: number }> {
	if (event.locals.user) return { ok: true, canForce: true };
	if (validateApiKey(event)) return { ok: true, canForce: true };
	const token = event.url.searchParams.get('token');
	if (token) {
		const client = await validateClientToken(token);
		if (client && client.projectSlug === event.params.slug) {
			return { ok: true, canForce: false };
		}
	}
	return { ok: false, status: 401 };
}

export const GET: RequestHandler = async (event) => {
	const auth = await authorize(event);
	if (!auth.ok) return json({ error: 'Unauthorized' }, { status: auth.status });

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const periodParam = event.url.searchParams.get('period');
	const parsed = parsePeriod(periodParam);
	if (!parsed) return json({ error: 'Param "period" attendu au format YYYY-MM' }, { status: 400 });

	const period = `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;
	const cached = await findCachedReport(project.id, period);
	if (!cached) return json({ summary: null }, { status: 200 });

	return json({
		summary: cached.summary,
		generatedAt: cached.generatedAt,
		model: cached.model,
		cached: true
	});
};

export const POST: RequestHandler = async (event) => {
	const auth = await authorize(event);
	if (!auth.ok) return json({ error: 'Unauthorized' }, { status: auth.status });

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const periodParam = event.url.searchParams.get('period');
	const parsed = parsePeriod(periodParam);
	if (!parsed) return json({ error: 'Param "period" attendu au format YYYY-MM' }, { status: 400 });

	const force = event.url.searchParams.get('force') === '1';
	if (force && !auth.canForce) {
		return json({ error: 'La régénération est réservée à l\'administrateur.' }, { status: 403 });
	}

	try {
		const { record } = await getOrGenerateReport(project.id, parsed.year, parsed.month, { force });
		return json({
			summary: record.summary,
			generatedAt: record.generatedAt,
			model: record.model,
			cached: record.cached
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Erreur inconnue';
		return json({ error: message }, { status: 500 });
	}
};
