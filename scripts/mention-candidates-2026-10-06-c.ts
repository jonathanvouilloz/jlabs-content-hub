/**
 * Correction de Jon (06/10) : Adam est gardé, à Jonction. Ajout au roster (alias « Dams »),
 * puis la mention « Dams », rejetée par erreur quelques minutes plus tôt, est rouverte et validée.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { applyAgentRosterChanges, getAgentRoster, resolveAgentMentionCandidate } from '../src/lib/server/reviews/agent-mention-service.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const JONCTION = 'locations/12743724963296165280';
const CANDIDATE = '2299fc3392bcd8ab897afe5b';

const roster = await getAgentRoster({ db, projectSlug: 'barberconcept' });
const added = await applyAgentRosterChanges({
	db, projectSlug: 'barberconcept', idempotencyKey: 'jon-2026-10-06-add-adam-jonction', actor: 'jon',
	baseVersion: roster.version, reason: 'Adam, à Jonction (« Dams » dans un avis du 12/08) — décision Jon, 06/10.',
	changes: [{ op: 'add_employee', employeeId: 'adam', displayName: 'Adam', locations: [JONCTION], aliases: ['Dams'] }]
});
console.log(`roster ${added.previousVersion} → ${added.version}`);

const reopened = await pool.query(
	`update seostats.review_mention_candidates
	 set status='candidate',
	     resolution_json = (resolution_json::jsonb || jsonb_build_object('reopenedBy','jon','reopenedAt',now()::text,'reopenReason','Rejet du 06/10 corrigé : Adam est gardé, à Jonction.'))::text,
	     updated_at = now()::text
	 where id=$1 and status='rejected'`, [CANDIDATE]);
console.log('rouverte:', reopened.rowCount);

const r = await resolveAgentMentionCandidate({
	db, projectSlug: 'barberconcept', candidateId: CANDIDATE, idempotencyKey: `jon-2026-10-06-candidate-${CANDIDATE}-adam`,
	actor: 'jon', decision: 'validate', employeeId: 'adam', note: 'Dams = Adam, Jonction.'
});
console.log('Dams →', r.candidate.status);
const rev = await pool.query(`select r.mentioned_employees from seostats.gmb_reviews r join seostats.review_mention_candidates c on c.review_id=r.review_id where c.id=$1`, [CANDIDATE]);
console.log('avis:', rev.rows[0].mentioned_employees);
await pool.end();
