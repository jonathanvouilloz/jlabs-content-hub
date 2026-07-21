import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { env } from '$env/dynamic/private';
import * as schema from './schema.js';

if (!env.DATABASE_URL) {
	throw new Error('DATABASE_URL is not set');
}

// WebSocket pour le driver Pool en environnement Node (< 22 sans WebSocket global).
// No-op si un WebSocket global existe déjà (Node 22+, edge).
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });
