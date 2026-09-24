/**
 * Publication contrôlée du lot Barber Concept préparé le 2026-08-21.
 *
 * Par défaut : relit Google et affiche le verdict, sans écrire ni publier.
 * --execute : GET Google → PUT si aucune réponse → GET de preuve, puis écrit
 * les deux marqueurs locaux depuis cette preuve uniquement.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { REPLIES } from './reply-reviews-2026-08-21.data.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');
neonConfig.webSocketConstructor = ws;

const EXECUTE = process.argv.includes('--execute');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
const project = await pool.query<{ id: string }>(
	"SELECT id FROM seostats.projects WHERE slug = 'barberconcept' LIMIT 1"
).then((result) => result.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');

const accessToken = await getGmbAccessToken(db, { persist: false });
const accountId = await getGmbAccountId(db);
if (!accountId) throw new Error('Compte Google Business introuvable.');

function idSegment(value: string, prefix: string): string {
	return value.replace(new RegExp(`^${prefix}/`), '');
}

/** Google renvoie parfois la traduction automatique après le texte original envoyé. */
function remoteReplyMatches(expected: string, actual: string | null): boolean {
	return actual === expected || actual?.startsWith(`${expected}\n\n(Translated by Google)\n`) === true;
}

async function readRemote(locationId: string, reviewId: string, expectedComment: string) {
	const url = `https://mybusiness.googleapis.com/v4/accounts/${idSegment(accountId, 'accounts')}/locations/${idSegment(locationId, 'locations')}/reviews/${idSegment(reviewId, 'reviews')}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (res.status === 404) return { kind: 'missing' as const };
	if (!res.ok) throw new Error(`GET Google échoué : ${res.status} ${await res.text()}`);
	const body = await res.json() as { comment?: unknown; reviewReply?: { comment?: unknown } };
	const remoteComment = typeof body.comment === 'string' ? body.comment : '';
	if (remoteComment !== expectedComment) {
		return { kind: 'changed' as const };
	}
	return {
		kind: 'present' as const,
		reply: typeof body.reviewReply?.comment === 'string' ? body.reviewReply.comment : null,
		url
	};
}

let verified = 0;
let blocked = 0;
for (const candidate of REPLIES) {
	const review = await pool.query<{
		review_id: string;
		location_id: string;
		rating: number;
		comment: string | null;
		replied_at: string | null;
		remote_reply_at: string | null;
	}>(
		`SELECT review_id, location_id, rating, comment, replied_at, remote_reply_at
		 FROM seostats.gmb_reviews WHERE project_id = $1 AND review_id = $2 LIMIT 1`,
		[project.id, candidate.reviewId]
	).then((result) => result.rows[0]);
	if (!review || review.rating !== 5 || review.replied_at !== null || review.remote_reply_at !== null) {
		console.log(`SKIP ${candidate.reviewId.slice(-12)} : état local non publiable`);
		blocked++;
		continue;
	}

	const before = await readRemote(review.location_id, review.review_id, review.comment ?? '');
	if (before.kind === 'missing' || before.kind === 'changed') {
		console.log(`BLOCKED ${candidate.reviewId.slice(-12)} : avis absent ou modifié côté Google`);
		blocked++;
		continue;
	}
	if (before.reply !== null && !remoteReplyMatches(candidate.reply, before.reply)) {
		console.log(`BLOCKED ${candidate.reviewId.slice(-12)} : réponse Google existante différente`);
		blocked++;
		continue;
	}
	if (!EXECUTE) {
		console.log(`READY ${candidate.reviewId.slice(-12)} : ${remoteReplyMatches(candidate.reply, before.reply) ? 'déjà vérifié' : 'prêt à envoyer'}`);
		continue;
	}
	if (before.reply === null) {
		const put = await fetch(`${before.url}/reply`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ comment: candidate.reply })
		});
		if (!put.ok) {
			console.log(`BLOCKED ${candidate.reviewId.slice(-12)} : PUT Google ${put.status}`);
			blocked++;
			continue;
		}
	}
	const after = await readRemote(review.location_id, review.review_id, review.comment ?? '');
	if (after.kind !== 'present' || !remoteReplyMatches(candidate.reply, after.reply)) {
		console.log(`BLOCKED ${candidate.reviewId.slice(-12)} : preuve Google absente ou divergente après PUT`);
		blocked++;
		continue;
	}
	const now = toDbTimestamp();
	await pool.query(
		`UPDATE seostats.gmb_reviews
		 SET draft_reply = $1, replied_at = $2, remote_reply_text = $3, remote_reply_at = $2
		 WHERE project_id = $4 AND review_id = $5
		   AND replied_at IS NULL AND remote_reply_at IS NULL`,
		[candidate.reply, now, after.reply, project.id, candidate.reviewId]
	);
	console.log(`VERIFIED ${candidate.reviewId.slice(-12)}`);
	verified++;
	await new Promise((resolve) => setTimeout(resolve, 350));
}

await pool.end();
console.log(JSON.stringify({ mode: EXECUTE ? 'execute' : 'dry-run', verified, blocked, candidates: REPLIES.length }));
if (blocked > 0) process.exitCode = 1;
