/**
 * Suite du 2026-10-06 (barberconcept), décisions de Jon :
 * - Henok Josief : rattaché à Rive, non comptabilisé ; « Heinok » = Henok (alias retenu).
 * - Ilias : mention gardée à Jonction (changement de salon), roster inchangé.
 * - « Dams » = Adam : rejeté puis rouvert et validé (voir -c).
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
const RIVE = 'locations/6692186161413459468';

const roster = await getAgentRoster({ db, projectSlug: 'barberconcept' });
const changed = await applyAgentRosterChanges({
	db, projectSlug: 'barberconcept', idempotencyKey: 'jon-2026-10-06-henok-rive-untracked', actor: 'jon',
	baseVersion: roster.version,
	reason: 'Henok Josief rattaché à Rive mais hors roster comptabilisé (décision Jon, 06/10).',
	changes: [
		{ op: 'set_locations', employeeId: 'henok-josief', locations: [RIVE] },
		{ op: 'set_track_mentions', employeeId: 'henok-josief', tracked: false }
	]
});
console.log(`roster ${changed.previousVersion} → ${changed.version}`);

for (const d of [
	{ id: 'e863635ccec361fc353c3cbc', token: 'Heinok', employeeId: 'henok-josief', rememberAlias: true, note: 'Heinok = Henok Josief, non comptabilisé.' },
	{ id: 'b3abb92b469bc58606dbaf4a', token: 'Ilias', employeeId: 'ilias', rememberAlias: false, note: 'Ilias a changé de salon ; mention gardée à Jonction.' }
]) {
	const r = await resolveAgentMentionCandidate({
		db, projectSlug: 'barberconcept', candidateId: d.id, idempotencyKey: `jon-2026-10-06-candidate-${d.id}`,
		actor: 'jon', decision: 'validate', employeeId: d.employeeId, rememberAlias: d.rememberAlias, note: d.note
	});
	console.log(`${d.token} → ${r.candidate.status}${r.alias ? ` alias=${JSON.stringify({ added: r.alias.added, version: r.alias.version, error: r.alias.error })}` : ''}`);
}
const left = await pool.query("select detected_token from seostats.review_mention_candidates where status='candidate'");
console.log('restent:', left.rows.map((r) => r.detected_token).join(', '));
await pool.end();
// Puis (Jon, 06/10) : « Dams » rejeté, corrigé dans -c (Adam ajouté à Jonction) ; « cuso » rejeté (non identifié).
