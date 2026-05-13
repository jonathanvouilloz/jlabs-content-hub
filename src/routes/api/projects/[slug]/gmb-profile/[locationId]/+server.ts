import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations, gmbLocationProfiles } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { syncLocationProfile } from '$lib/server/gmb.js';
import { and, eq } from 'drizzle-orm';

const STALE_AFTER_MS = 60 * 60 * 1000; // 1h

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const locationId = normalizeLocationId(event.params.locationId);

	// Vérifier que la location appartient bien au projet
	const link = await db
		.select()
		.from(projectGmbLocations)
		.where(
			and(
				eq(projectGmbLocations.projectId, project.id),
				eq(projectGmbLocations.gmbLocationId, locationId)
			)
		)
		.get();
	if (!link) return errorResponse('Location not assigned to project', 404);

	const forceRefresh = event.url.searchParams.get('refresh') === '1';

	let profile = await db
		.select()
		.from(gmbLocationProfiles)
		.where(
			and(
				eq(gmbLocationProfiles.projectId, project.id),
				eq(gmbLocationProfiles.gmbLocationId, locationId)
			)
		)
		.get();

	const stale = profile
		? Date.now() - new Date(profile.syncedAt).getTime() > STALE_AFTER_MS
		: true;

	if (!profile || stale || forceRefresh) {
		try {
			profile = await syncLocationProfile(project.id, locationId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Sync failed';
			// Si on a un cache, on le renvoie quand même avec un flag warning
			if (profile) {
				return jsonResponse({ profile, link, warning: msg });
			}
			return errorResponse(msg, 502);
		}
	}

	return jsonResponse({ profile, link });
};
