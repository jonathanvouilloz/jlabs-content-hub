import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations, gmbProfileEdits } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { patchLocation, syncLocationProfile } from '$lib/server/gmb.js';
import { createId } from '$lib/server/utils.js';
import { and, eq } from 'drizzle-orm';

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

interface BasicPayload {
	title?: string;
	phone?: string | null;
	additionalPhones?: string[];
	websiteUri?: string | null;
	openStatus?: 'OPEN' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
}

export const PATCH: RequestHandler = async (event) => {
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
		.get();
	if (!link) return errorResponse('Location not assigned to project', 404);

	let payload: BasicPayload;
	try {
		payload = (await event.request.json()) as BasicPayload;
	} catch {
		return errorResponse('Invalid JSON payload', 400);
	}

	const masks: string[] = [];
	const body: Record<string, unknown> = {};

	if (typeof payload.title === 'string') {
		if (!payload.title.trim()) return errorResponse('title cannot be empty', 400);
		body.title = payload.title.trim();
		masks.push('title');
	}

	if (typeof payload.websiteUri !== 'undefined') {
		body.websiteUri = payload.websiteUri ?? '';
		masks.push('websiteUri');
	}

	const phoneTouched = typeof payload.phone !== 'undefined';
	const additionalTouched = Array.isArray(payload.additionalPhones);
	if (phoneTouched || additionalTouched) {
		const phoneNumbers: Record<string, unknown> = {};
		if (phoneTouched) phoneNumbers.primaryPhone = payload.phone ?? '';
		if (additionalTouched) phoneNumbers.additionalPhones = payload.additionalPhones;
		body.phoneNumbers = phoneNumbers;
		masks.push('phoneNumbers');
	}

	if (payload.openStatus) {
		body.openInfo = { status: payload.openStatus };
		masks.push('openInfo.status');
	}

	if (masks.length === 0) {
		return errorResponse('No editable field provided', 400);
	}

	const updateMask = masks.join(',');
	const editId = createId();
	const userId = event.locals.user?.id ?? 'admin';

	try {
		await patchLocation(locationId, updateMask, body);

		await db.insert(gmbProfileEdits).values({
			id: editId,
			projectId: project.id,
			gmbLocationId: locationId,
			section: 'basic',
			updateMask,
			payload: JSON.stringify(body),
			success: true,
			errorMessage: null,
			changedBy: userId
		});

		const profile = await syncLocationProfile(project.id, locationId);
		return jsonResponse({ profile });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Patch failed';
		await db.insert(gmbProfileEdits).values({
			id: editId,
			projectId: project.id,
			gmbLocationId: locationId,
			section: 'basic',
			updateMask,
			payload: JSON.stringify(body),
			success: false,
			errorMessage: msg,
			changedBy: userId
		});
		return errorResponse(msg, 502);
	}
};
