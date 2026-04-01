import type { RequestHandler } from './$types.js';
import { auth } from '$lib/server/auth.js';
import { db } from '$lib/server/db/index.js';
import { user } from '$lib/server/db/schema.js';
import { seedContentTypes } from '$lib/server/db/seed.js';

export const POST: RequestHandler = async ({ request }) => {
	// Check if any user already exists
	const existingUsers = await db.select().from(user).limit(1);
	if (existingUsers.length > 0) {
		return new Response(JSON.stringify({ error: 'Setup already completed' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const body = await request.json();
	const { name, email, password } = body;

	if (!name || !email || !password) {
		return new Response(JSON.stringify({ error: 'name, email, password required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Create admin user via Better Auth
	const result = await auth.api.signUpEmail({
		body: { name, email, password }
	});

	// Seed content types
	await seedContentTypes();

	return new Response(JSON.stringify({ ok: true, user: { name, email } }), {
		status: 201,
		headers: { 'Content-Type': 'application/json' }
	});
};
