import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects, trackedKeywords } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { RequestHandler } from './$types';

async function resolveKeyword(event: Parameters<RequestHandler>[0]) {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return { error: json({ error: 'Project not found' }, { status: 404 }) };

	const kw = await db.query.trackedKeywords.findFirst({
		where: and(eq(trackedKeywords.id, event.params.id), eq(trackedKeywords.projectId, project.id))
	});
	if (!kw) return { error: json({ error: 'Keyword not found' }, { status: 404 }) };
	return { project, kw };
}

/** PATCH — met à jour la cible (url / position) d'un mot-clé suivi. */
export const PATCH: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const resolved = await resolveKeyword(event);
	if (resolved.error) return resolved.error;

	let body: { targetUrl?: string | null; targetPosition?: number | null; archived?: boolean };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'JSON invalide' }, { status: 400 });
	}

	const set: Partial<typeof trackedKeywords.$inferInsert> = {};
	if ('targetUrl' in body) set.targetUrl = body.targetUrl?.trim() || null;
	if ('targetPosition' in body) {
		set.targetPosition =
			body.targetPosition == null || Number.isNaN(Number(body.targetPosition))
				? null
				: Number(body.targetPosition);
	}
	if ('archived' in body) set.archived = !!body.archived;

	if (Object.keys(set).length === 0) {
		return json({ error: 'Rien à mettre à jour' }, { status: 400 });
	}

	await db.update(trackedKeywords).set(set).where(eq(trackedKeywords.id, resolved.kw.id));
	const updated = await db.query.trackedKeywords.findFirst({
		where: eq(trackedKeywords.id, resolved.kw.id)
	});
	return json({ ok: true, keyword: updated });
};

/** DELETE — archive le mot-clé (soft delete, préserve l'historique de curation). */
export const DELETE: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const resolved = await resolveKeyword(event);
	if (resolved.error) return resolved.error;

	await db
		.update(trackedKeywords)
		.set({ archived: true })
		.where(eq(trackedKeywords.id, resolved.kw.id));
	return json({ ok: true });
};
