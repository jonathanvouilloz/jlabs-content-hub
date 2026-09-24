import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent.');
const EXECUTE = process.argv.includes('--execute');

type Mention = { name: string; sentiment: 'positive' | 'neutral' | 'negative' };
const CORRECTIONS: Array<{
	reviewId: string;
	authorName: string;
	expected: Mention[] | null;
	next: Mention[] | null;
	reason: string;
}> = [
	{
		reviewId: 'AbFvOqmik9tgl0BSaSLRL2zHhE6VDftZOR3i87a0VWUubqengXiPoFmyolJ5R3JpYUxYFuGtWJjnYA',
		authorName: 'Holden Peixoto',
		expected: [],
		next: [{ name: 'Giuseppe', sentiment: 'positive' }],
		reason: 'Giuseppe est cité explicitement.'
	},
	{
		reviewId: 'AbFvOqnPKG2cps3jEpq8SoTQxVU1HDnELghEfF8bWnkkNbwqSP2UqzRDpIreuRAxwlyNA1qcvAgEqw',
		authorName: 'Leandro Schumacher',
		expected: [],
		next: [{ name: 'Giuseppe', sentiment: 'positive' }],
		reason: 'Giuseppe est cité explicitement.'
	},
	{
		reviewId: 'AbFvOqkneIfIjT0uziAUunPl1e50hcsC3TOigxSMCsgKwCQGhWISi0_WR2pCMP3FR_oND9D59ws0Ig',
		authorName: 'Lyam Baruselli',
		expected: [{ name: 'Mohammed', sentiment: 'positive' }],
		next: null,
		reason: 'Mohamed n’est pas un alias validé de Mohammed.'
	},
	{
		reviewId: 'AbFvOql462krWXNKQHQ_9WexyUxRGRsSAuxBiLazqDS9p51OeMsBdz49KPlVEGK_1dAcPmshSjrLdA',
		authorName: 'alexis fhomadison',
		expected: [{ name: 'Alexis', sentiment: 'positive' }],
		next: null,
		reason: 'Alexi n’est pas un alias validé d’Alexis.'
	},
	{
		reviewId: 'AbFvOqnB0We_WQQezmFUUVr-b2l_w5w-Lvq50l9Np7rc9NcVIDKS7Za6DgWRloymjPTT1Hc9-2dH',
		authorName: 'Arthur',
		expected: [{ name: 'Brandon', sentiment: 'positive' }],
		next: null,
		reason: 'Benger avait été attribué à Brandon sans alias validé.'
	},
	{
		reviewId: 'AbFvOqlm14MWfsHKKAlGEhLSwUonrDftOeUL9NQrsavsqGBx8CulZxc3xTbfOoGzT0oN_qR9z7N7uw',
		authorName: 'spartak tesfai',
		expected: [],
		next: null,
		reason: 'Dams est cité mais absent du roster canonique.'
	}
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{ id: string }>("select id from seostats.projects where slug='barberconcept' limit 1").then((result) => result.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');
const ids = CORRECTIONS.map((item) => item.reviewId);
const rows = await pool.query<{
	review_id: string;
	author_name: string;
	mentioned_employees: string | null;
}>(
	`select review_id, author_name, mentioned_employees from seostats.gmb_reviews
	 where project_id=$1 and review_id=any($2::text[])`,
	[project.id, ids]
).then((result) => result.rows);
if (rows.length !== CORRECTIONS.length) throw new Error(`Périmètre incomplet : ${rows.length}/${CORRECTIONS.length}.`);
const byId = new Map(rows.map((row) => [row.review_id, row]));
const normalized = (value: string | null): string | null => value === null ? null : JSON.stringify(JSON.parse(value));
for (const item of CORRECTIONS) {
	const row = byId.get(item.reviewId)!;
	if (row.author_name !== item.authorName) throw new Error(`Auteur divergent : ${item.reviewId}`);
	const current = normalized(row.mentioned_employees);
	const expected = item.expected === null ? null : JSON.stringify(item.expected);
	const next = item.next === null ? null : JSON.stringify(item.next);
	if (current !== expected && current !== next) throw new Error(`État concurrent inattendu : ${item.reviewId}`);
	console.log(`- ${item.authorName}: ${current ?? 'NULL'} -> ${next ?? 'NULL'} | ${item.reason}`);
}
if (!EXECUTE) {
	console.log(JSON.stringify({ mode: 'dry-run', corrections: CORRECTIONS.length }));
	await pool.end();
	process.exit(0);
}

const client = await pool.connect();
let written = 0;
let alreadyMatching = 0;
try {
	await client.query('begin');
	for (const item of CORRECTIONS) {
		const row = byId.get(item.reviewId)!;
		const current = normalized(row.mentioned_employees);
		const next = item.next === null ? null : JSON.stringify(item.next);
		if (current === next) {
			alreadyMatching += 1;
			continue;
		}
		const expected = item.expected === null ? null : JSON.stringify(item.expected);
		const result = expected === null
			? await client.query(
				`update seostats.gmb_reviews set mentioned_employees=$1
				 where project_id=$2 and review_id=$3 and mentioned_employees is null`,
				[next, project.id, item.reviewId]
			)
			: await client.query(
				`update seostats.gmb_reviews set mentioned_employees=$1
				 where project_id=$2 and review_id=$3 and mentioned_employees=$4`,
				[next, project.id, item.reviewId, expected]
			);
		if (result.rowCount !== 1) throw new Error(`Correction concurrente : ${item.reviewId}`);
		written += 1;
	}
	await client.query('commit');
} catch (error) {
	await client.query('rollback');
	throw error;
} finally {
	client.release();
}
console.log(JSON.stringify({ mode: 'execute-db-only', written, alreadyMatching }));
await pool.end();
