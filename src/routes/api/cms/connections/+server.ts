import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { cmsConnections, projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { encrypt } from '$lib/server/crypto.js';
import { createId } from '$lib/server/utils.js';
import { getAdapter } from '$lib/server/cms/index.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { projectId, cmsType, config, apiToken } = body;

	if (!projectId || !cmsType || !config || !apiToken) {
		return json({ error: 'Missing required fields' }, { status: 400 });
	}

	// Validate CMS type
	try {
		getAdapter(cmsType);
	} catch {
		return json({ error: `Unsupported CMS type: ${cmsType}` }, { status: 400 });
	}

	// Check project exists
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId)
	});
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	// Delete existing connection if any
	await db.delete(cmsConnections).where(eq(cmsConnections.projectId, projectId));

	// Insert new connection
	const id = createId();
	await db.insert(cmsConnections).values({
		id,
		projectId,
		cmsType,
		config: JSON.stringify(config),
		apiToken: encrypt(apiToken)
	});

	return json({ ok: true, data: { id } }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const projectId = url.searchParams.get('projectId');
	if (!projectId) {
		return json({ error: 'Missing projectId' }, { status: 400 });
	}

	await db.delete(cmsConnections).where(eq(cmsConnections.projectId, projectId));
	return json({ ok: true });
};
