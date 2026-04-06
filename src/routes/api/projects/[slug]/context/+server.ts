import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, projectContexts } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createId } from '$lib/server/utils.js';
import type { RequestHandler } from './$types';

async function getProject(slug: string) {
	return db.query.projects.findFirst({ where: eq(projects.slug, slug) });
}

export const GET: RequestHandler = async (event) => {
	const { params, locals } = event;
	if (!locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await getProject(params.slug);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const row = await db.query.projectContexts.findFirst({
		where: eq(projectContexts.projectId, project.id)
	});

	return json({ context: row ? JSON.parse(row.context) : null });
};

export const PUT: RequestHandler = async (event) => {
	const { params, locals, request } = event;
	if (!locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await getProject(params.slug);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await request.json();
	if (!body.businessName || !body.businessType || !body.locality) {
		return json({ error: 'businessName, businessType and locality are required' }, { status: 400 });
	}

	const contextJson = JSON.stringify(body);
	const now = new Date().toISOString();

	await db
		.insert(projectContexts)
		.values({
			id: createId(),
			projectId: project.id,
			context: contextJson,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: projectContexts.projectId,
			set: { context: contextJson, updatedAt: now }
		});

	return json({ context: body });
};
