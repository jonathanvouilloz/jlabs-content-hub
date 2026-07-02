import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { seoReports } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const report = await db.query.seoReports.findFirst({
		where: eq(seoReports.id, event.params.id)
	});
	if (!report) return errorResponse('Report not found', 404);

	return jsonResponse(report);
};

export const DELETE: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	await db.delete(seoReports).where(eq(seoReports.id, event.params.id));
	return jsonResponse({ deleted: true });
};
