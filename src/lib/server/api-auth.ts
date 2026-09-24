import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db/index.js';
import { projects } from './db/schema.js';
import { inArray } from 'drizzle-orm';
import {
	authenticateMachineBearer,
	credentialAllowsProject,
	type MachineAuthResult
} from './machine-auth.js';
import { clientTokenStorageCandidates } from './client-token.js';
import { legacyMachineScopeForRequest } from './api-auth-policy.js';

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; status: number };

/** Auth machine par hash + scope. La configuration ne contient aucun bearer brut. */
export function authorizeMachine(event: RequestEvent, requiredScope: string): MachineAuthResult {
	return authenticateMachineBearer(
		event.request.headers.get('authorization'),
		requiredScope,
		env.MACHINE_CREDENTIALS_JSON,
		undefined,
		env.HERMES_MACHINE_CREDENTIALS_JSON
	);
}

/** Accès agent : un scope valide ne suffit pas, le slug doit être explicitement autorisé. */
export function authorizeMachineProject(
	event: RequestEvent,
	requiredScope: string,
	projectSlug: string
): MachineAuthResult {
	const result = authorizeMachine(event, requiredScope);
	if (!result.ok) return result;
	return credentialAllowsProject(result.credential, projectSlug)
		? result
		: { ok: false, status: 403, code: 'forbidden' };
}

/**
 * Compatibilité temporaire des routes non encore migrées vers `authorizeMachine` :
 * le scope est dérivé d'une politique explicite et toute route inconnue échoue fermée.
 */
export function validateApiKey(event: RequestEvent, requiredScope?: string): boolean {
	const scope = requiredScope ?? legacyMachineScopeForRequest(event.request.method, event.url.pathname);
	return scope ? authorizeMachine(event, scope).ok : false;
}

export async function validateClientToken(
	token: string
): Promise<{ projectId: string; projectSlug: string } | null> {
	const candidates = clientTokenStorageCandidates(token);
	if (candidates.length === 0) return null;
	const project = await db.query.projects.findFirst({
		where: inArray(projects.accessToken, candidates)
	});
	if (!project || project.archived) return null;
	return { projectId: project.id, projectSlug: project.slug };
}

export function machineAuthError(result: Exclude<MachineAuthResult, { ok: true }>): Response {
	return errorResponse(result.status === 403 ? 'Forbidden' : 'Unauthorized', result.status);
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
