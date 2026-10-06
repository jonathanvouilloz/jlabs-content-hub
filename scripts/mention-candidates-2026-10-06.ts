/**
 * Candidates de mentions en attente depuis le 02/10 (barberconcept) — tranchées avec Jon le 2026-10-06.
 * 16 décisions sûres ; restent à Jon : Heinok, Dams, cuso, Ilias (Jonction).
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { resolveAgentMentionCandidate } from '../src/lib/server/reviews/agent-mention-service.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent.');

type D = { id: string; token: string; decision: 'validate' | 'reject'; employeeId?: string; rememberAlias?: boolean; note: string };
const DECISIONS: D[] = [
	{ id: 'bc8d3267664d34034ab13d52', token: 'Alexi', decision: 'validate', employeeId: 'alexis', note: 'Texte « Alexis est très pro », Sion.' },
	{ id: '816eff4ed7be09fe0c4db339', token: 'HK barber', decision: 'validate', employeeId: 'hk', note: '« HK barber », Jonction.' },
	{ id: '70c94e2d24350ec25b294078', token: 'Muguy Barber', decision: 'validate', employeeId: 'muguy', note: '« Muguy Barber », Eaux-Vives.' },
	{ id: 'dc38c74ca4eb10eadc75132a', token: 'N2r', decision: 'validate', employeeId: 'n2', note: '« le nouveau coiffeur N2r », Sion.' },
	{ id: 'acb3c693f251c0e503fba569', token: 'Emmanuel', decision: 'validate', employeeId: 'emanuel', rememberAlias: true, note: 'Orthographe à deux m, Sion.' },
	{ id: '2ae75a7dba8e3b79836c82a4', token: 'Mohamed', decision: 'validate', employeeId: 'mohammed', rememberAlias: true, note: 'Orthographe à un m, Jonction.' },
	{ id: 'ef591f323b7e789d6a280f98', token: 'Raph', decision: 'validate', employeeId: 'raphael', rememberAlias: true, note: 'Diminutif, Lausanne.' },
	{ id: '0a47e4d312fdc7b71915702a', token: 'Jesse', decision: 'validate', employeeId: 'jessy', rememberAlias: true, note: 'Variante, Rive.' },
	{ id: '16064f2aa312598b6ecc6327', token: 'Noah', decision: 'reject', note: 'Le texte dit « Noé » ; avis déjà rattaché à Noé.' },
	...['7851c6fe21da32a7dcebca68', 'ba9a1bc67d1497076c3c1918', 'd0839bb163dcc293b9c2b41c', '136ec97657f3c91a33ae86c8', '5d4fb2e4bc79815840cbdcde', '459b86dea97b819a8ecb94f4', '3b85c47192c74031b243a90c'].map(
		(id): D => ({ id, token: 'Kavind', decision: 'reject', note: 'Kavind parti (inactif) ; la mention historique de juin reste sur l’avis.' })
	)
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
for (const d of DECISIONS) {
	try {
		const r = await resolveAgentMentionCandidate({
			db, projectSlug: 'barberconcept', candidateId: d.id, idempotencyKey: `jon-2026-10-06-candidate-${d.id}`,
			actor: 'jon', decision: d.decision, employeeId: d.employeeId ?? null, rememberAlias: d.rememberAlias ?? false, note: d.note
		});
		console.log(`${d.token} → ${r.candidate.status}${r.alias ? ` alias=${JSON.stringify({ added: r.alias.added, version: r.alias.version, error: r.alias.error })}` : ''}`);
	} catch (e) {
		console.log(`${d.token} ✗ ${(e as { code?: string }).code ?? (e as Error).message}`);
	}
}
await pool.end();
