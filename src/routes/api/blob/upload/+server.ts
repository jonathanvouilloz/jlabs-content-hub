import type { RequestHandler } from './$types.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { uploadGmbImage } from '$lib/server/blob.js';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB (Vercel Functions Node body limit)

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	let formData: FormData;
	try {
		formData = await event.request.formData();
	} catch {
		return errorResponse('Invalid multipart body', 400);
	}

	const file = formData.get('file');
	const projectSlug = formData.get('project_slug');
	const filenameField = formData.get('filename');

	if (!(file instanceof File)) {
		return errorResponse('Missing file (multipart field "file")', 400);
	}
	if (typeof projectSlug !== 'string' || !projectSlug) {
		return errorResponse('Missing project_slug', 400);
	}

	if (file.size > MAX_BYTES) {
		return errorResponse(`File too large (max ${MAX_BYTES} bytes)`, 413);
	}

	const filename = (typeof filenameField === 'string' && filenameField) || file.name;

	try {
		const buffer = Buffer.from(await file.arrayBuffer());
		const result = await uploadGmbImage({
			projectSlug,
			filename,
			data: buffer,
			contentType: file.type || 'application/octet-stream'
		});
		return jsonResponse(result);
	} catch (e) {
		return errorResponse(`Upload failed: ${(e as Error).message}`, 500);
	}
};
