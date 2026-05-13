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

interface TimeOfDay {
	hours?: number;
	minutes?: number;
}
interface Period {
	openDay: string;
	openTime?: TimeOfDay;
	closeDay: string;
	closeTime?: TimeOfDay;
}
interface SpecialDate {
	year: number;
	month: number;
	day: number;
}
interface SpecialHourPeriod {
	startDate: SpecialDate;
	openTime?: TimeOfDay;
	endDate?: SpecialDate;
	closeTime?: TimeOfDay;
	closed?: boolean;
}

interface HoursPayload {
	regularHours?: { periods: Period[] };
	specialHours?: { specialHourPeriods: SpecialHourPeriod[] };
}

const VALID_DAYS = new Set([
	'MONDAY',
	'TUESDAY',
	'WEDNESDAY',
	'THURSDAY',
	'FRIDAY',
	'SATURDAY',
	'SUNDAY'
]);

function validatePeriod(p: Period): string | null {
	if (!VALID_DAYS.has(p.openDay)) return `openDay invalide: ${p.openDay}`;
	if (!VALID_DAYS.has(p.closeDay)) return `closeDay invalide: ${p.closeDay}`;
	return null;
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

	let payload: HoursPayload;
	try {
		payload = (await event.request.json()) as HoursPayload;
	} catch {
		return errorResponse('Invalid JSON payload', 400);
	}

	const masks: string[] = [];
	const body: Record<string, unknown> = {};

	if (payload.regularHours) {
		const periods = payload.regularHours.periods ?? [];
		for (const p of periods) {
			const err = validatePeriod(p);
			if (err) return errorResponse(err, 400);
		}
		body.regularHours = { periods };
		masks.push('regularHours');
	}

	if (payload.specialHours) {
		body.specialHours = { specialHourPeriods: payload.specialHours.specialHourPeriods ?? [] };
		masks.push('specialHours');
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
			section: 'hours',
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
			section: 'hours',
			updateMask,
			payload: JSON.stringify(body),
			success: false,
			errorMessage: msg,
			changedBy: userId
		});
		return errorResponse(msg, 502);
	}
};
