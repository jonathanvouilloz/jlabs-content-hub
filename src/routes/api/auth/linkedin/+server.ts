import { redirect } from '@sveltejs/kit';
import { getAuthUrl } from '$lib/server/linkedin.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	redirect(302, getAuthUrl(url.origin));
};
