/**
 * Récap avis septembre 2026 (barberconcept) — mentions jamais extraites, tranchées par Jon le 2026-10-01.
 * 1. Roster : alias `Ousman` → Ouss (Rive), par `applyAgentRosterChanges` (nouvelle projection hashée).
 * 2. `mentioned_employees` des 5 avis restés à NULL (ni détecteur ni Hermes ne les a traités).
 * `cuso` (Rive) reste non attribué : aucun membre du roster ne correspond.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { applyAgentRosterChanges, getAgentRoster } from '../src/lib/server/reviews/agent-mention-service.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent.');
const EXECUTE = process.argv.includes('--execute');

type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
const CORRECTIONS: Array<{ authorName: string; createDay: string; next: Mention[]; reason: string }> = [
	{ authorName: 'Djulian', createDay: '2026-09-30', next: [{ name: 'Issam', sentiment: 'positive' }], reason: '« bienIssam » : prénom collé au mot précédent.' },
	{ authorName: 'Timur Aytekin', createDay: '2026-09-30', next: [{ name: 'Moss', sentiment: 'positive' }], reason: '« moss » cité à Eaux-Vives.' },
	{ authorName: 'jaccphil', createDay: '2026-09-09', next: [{ name: 'Ouss', sentiment: 'positive' }], reason: 'Ousman = Ouss (décision Jon).' },
	{ authorName: 'Mattia Borloz', createDay: '2026-09-30', next: [], reason: 'Aucun prénom cité.' },
	{ authorName: 'tsh_forever tsh_forever', createDay: '2026-09-29', next: [], reason: 'Avis sans texte.' }
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const project = await pool.query<{ id: string }>("select id from seostats.projects where slug='barberconcept' limit 1").then((r) => r.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');

const rows = [];
for (const item of CORRECTIONS) {
	const found = await pool.query<{ review_id: string; mentioned_employees: string | null }>(
		`select review_id, mentioned_employees from seostats.gmb_reviews
		 where project_id=$1 and author_name=$2 and left(create_time,10)=$3`,
		[project.id, item.authorName, item.createDay]
	).then((r) => r.rows);
	if (found.length !== 1) throw new Error(`Avis introuvable ou ambigu : ${item.authorName} (${found.length})`);
	const current = found[0].mentioned_employees;
	const next = JSON.stringify(item.next);
	if (current !== null && current !== next) throw new Error(`État concurrent inattendu : ${item.authorName} = ${current}`);
	console.log(`- ${item.authorName}: ${current ?? 'NULL'} -> ${next} | ${item.reason}`);
	rows.push({ reviewId: found[0].review_id, current, next });
}

const roster = await getAgentRoster({ db, projectSlug: 'barberconcept' });
const rosterJson = JSON.stringify(roster);
const hasAlias = /"Ousman"/.test(rosterJson);
console.log(`- roster : alias Ousman → ouss ${hasAlias ? 'déjà présent' : 'à ajouter'}`);

if (!EXECUTE) {
	console.log(JSON.stringify({ mode: 'dry-run', corrections: rows.length, alias: !hasAlias }));
	await pool.end();
	process.exit(0);
}

if (!hasAlias) {
	const baseVersion = roster.version;
	const result = await applyAgentRosterChanges({
		db,
		projectSlug: 'barberconcept',
		idempotencyKey: 'jon-2026-10-01-alias-ousman-ouss',
		actor: 'jon',
		baseVersion,
		reason: 'Ousman = Ouss (Rive), décision Jon sur le récap de septembre.',
		changes: [{ op: 'add_alias', employeeId: 'ouss', alias: 'Ousman' }]
	});
	console.log(`- roster : ${result.previousVersion} -> ${result.version}`);
}

const client = await pool.connect();
let written = 0;
try {
	await client.query('begin');
	for (const row of rows) {
		if (row.current === row.next) continue;
		const result = await client.query(
			`update seostats.gmb_reviews set mentioned_employees=$1
			 where project_id=$2 and review_id=$3 and mentioned_employees is null`,
			[row.next, project.id, row.reviewId]
		);
		if (result.rowCount !== 1) throw new Error(`Correction concurrente : ${row.reviewId}`);
		written += 1;
	}
	await client.query('commit');
} catch (error) {
	await client.query('rollback');
	throw error;
} finally {
	client.release();
}
console.log(JSON.stringify({ mode: 'execute', written }));
await pool.end();
