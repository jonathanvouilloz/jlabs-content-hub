import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { encrypt } from '$lib/server/crypto.js';
import { setGmbSetting } from '$lib/server/gmb.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (error) {
		redirect(303, '/projects?gmb_error=consent_denied');
	}

	if (!code) {
		return new Response('Missing authorization code', { status: 400 });
	}

	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID || '',
			client_secret: env.GOOGLE_CLIENT_SECRET || '',
			redirect_uri: `${url.origin}/api/auth/google/callback`,
			grant_type: 'authorization_code'
		})
	});

	if (!res.ok) {
		const text = await res.text();
		return new Response(`Token exchange failed: ${text}`, { status: 500 });
	}

	const data = await res.json();

	const tokens = {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expiry: new Date(Date.now() + data.expires_in * 1000).toISOString()
	};

	const encryptedTokens = encrypt(JSON.stringify(tokens));
	await setGmbSetting('account_tokens', encryptedTokens);

	// Auto-detect GMB account ID
	try {
		const accountsRes = await fetch(
			'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
			{ headers: { Authorization: `Bearer ${tokens.access_token}` } }
		);
		if (accountsRes.ok) {
			const accountsData = await accountsRes.json();
			if (accountsData.accounts?.length > 0) {
				await setGmbSetting('account_id', accountsData.accounts[0].name);
			}
		}
	} catch {
		// Non-blocking — admin can configure manually
	}

	redirect(303, '/projects?gmb_connected=1');
};
