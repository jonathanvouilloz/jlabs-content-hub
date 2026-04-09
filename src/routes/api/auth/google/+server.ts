import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { gmbSettings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID || '',
		redirect_uri: `${url.origin}/api/auth/google/callback`,
		response_type: 'code',
		scope: 'https://www.googleapis.com/auth/business.manage',
		access_type: 'offline',
		prompt: 'consent',
		state: 'account'
	});

	redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	await db.delete(gmbSettings).where(eq(gmbSettings.key, 'account_tokens'));
	await db.delete(gmbSettings).where(eq(gmbSettings.key, 'account_id'));

	return Response.json({ ok: true });
};
