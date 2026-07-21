import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { syncLocationProfile, syncLocationInsights } from '$lib/server/gmb.js';
import { and, eq } from 'drizzle-orm';

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const locationId = normalizeLocationId(event.params.locationId);

	const link = await db
		.select()
		.from(projectGmbLocations)
		.where(
			and(
				eq(projectGmbLocations.projectId, project.id),
				eq(projectGmbLocations.gmbLocationId, locationId)
			)
		)
		.then((r) => r[0]);
	if (!link) return errorResponse('Location not assigned to project', 404);

	const errors: string[] = [];
	let profile = null;
	let insightsResult: { inserted: number; updated: number } | null = null;

	try {
		profile = await syncLocationProfile(project.id, locationId);
	} catch (err) {
		errors.push(`Profile sync: ${err instanceof Error ? err.message : 'unknown error'}`);
	}

	try {
		insightsResult = await syncLocationInsights(project.id, locationId, 90);
	} catch (err) {
		errors.push(`Insights sync: ${err instanceof Error ? err.message : 'unknown error'}`);
	}

	if (errors.length > 0 && !profile && !insightsResult) {
		return errorResponse(errors.join(' / '), 502);
	}

	return jsonResponse({
		profile: profile ? { syncedAt: profile.syncedAt } : null,
		insights: insightsResult,
		warnings: errors
	});
};
