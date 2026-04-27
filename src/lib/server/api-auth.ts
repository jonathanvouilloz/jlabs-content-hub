import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db/index.js';
import { projects } from './db/schema.js';
import { eq } from 'drizzle-orm';

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; status: number };

export function validateApiKey(event: RequestEvent): boolean {
	const authHeader = event.request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) return false;
	return authHeader.slice(7) === env.API_KEY;
}

export async function validateClientToken(
	token: string
): Promise<{ projectId: string; projectSlug: string } | null> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.accessToken, token)
	});
	if (!project || project.archived) return null;
	return { projectId: project.id, projectSlug: project.slug };
}

export function jsonResponse<T>(data: T, status = 200): Response {
	return new Response(JSON.stringify({ ok: true, data }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export function errorResponse(error: string, status: number): Response {
	return new Response(JSON.stringify({ ok: false, error, status }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}
