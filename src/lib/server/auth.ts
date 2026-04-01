import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db/index.js';
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL } from '$env/static/private';

export const auth = betterAuth({
	baseURL: BETTER_AUTH_URL,
	secret: BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'sqlite' }),
	emailAndPassword: {
		enabled: true
	}
});
