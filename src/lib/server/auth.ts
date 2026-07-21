import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { env } from '$env/dynamic/private';
import { db } from './db/index.js';

const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins,
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: {
		enabled: true
	}
});
