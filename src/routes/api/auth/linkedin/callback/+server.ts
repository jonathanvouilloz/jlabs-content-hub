import { redirect } from '@sveltejs/kit';
import { encrypt } from '$lib/server/crypto.js';
import { exchangeCode, getProfile, setLinkedinSetting } from '$lib/server/linkedin.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (error) {
		redirect(303, '/?linkedin_error=consent_denied');
	}

	if (!code) {
		return new Response('Missing authorization code', { status: 400 });
	}

	const tokens = await exchangeCode(code, url.origin);

	// Store encrypted tokens
	await setLinkedinSetting('account_tokens', encrypt(JSON.stringify(tokens)));

	// Fetch and store profile info
	try {
		const profile = await getProfile(tokens.access_token);
		await setLinkedinSetting('person_id', profile.id);
		await setLinkedinSetting('person_name', profile.name);
	} catch {
		// Non-blocking — can configure manually
	}

	redirect(303, '/?linkedin_connected=1');
};
