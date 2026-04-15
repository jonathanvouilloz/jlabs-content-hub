import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { deleteCredentials, getCredentials, saveCredentials } from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

async function requireAuth(event: Parameters<RequestHandler>[0]) {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	return null;
}

async function getProject(slug: string) {
	return db.query.projects.findFirst({ where: eq(projects.slug, slug) });
}

export const GET: RequestHandler = async (event) => {
	const unauth = await requireAuth(event);
	if (unauth) return unauth;

	const project = await getProject(event.params.slug);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const row = await getCredentials(project.id);
	if (!row) return json({ credentials: null });

	return json({
		credentials: {
			serviceAccountEmail: row.serviceAccountEmail,
			siteUrl: row.siteUrl,
			sitemapUrl: row.sitemapUrl,
			publicUrlTemplate: row.publicUrlTemplate,
			autoSubmitOnPublish: row.autoSubmitOnPublish,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt
		}
	});
};

export const POST: RequestHandler = async (event) => {
	const unauth = await requireAuth(event);
	if (unauth) return unauth;

	const project = await getProject(event.params.slug);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await event.request.json();
	if (!body.serviceAccountJson || typeof body.serviceAccountJson !== 'string') {
		return json({ error: 'serviceAccountJson is required' }, { status: 400 });
	}

	try {
		const { serviceAccountEmail } = await saveCredentials({
			projectId: project.id,
			serviceAccountJsonRaw: body.serviceAccountJson,
			siteUrl: body.siteUrl ?? null,
			sitemapUrl: body.sitemapUrl ?? null,
			publicUrlTemplate: body.publicUrlTemplate ?? null,
			autoSubmitOnPublish: !!body.autoSubmitOnPublish
		});
		return json({ ok: true, serviceAccountEmail });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Invalid credentials';
		return json({ error: msg }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const unauth = await requireAuth(event);
	if (unauth) return unauth;

	const project = await getProject(event.params.slug);
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	await deleteCredentials(project.id);
	return json({ ok: true });
};
