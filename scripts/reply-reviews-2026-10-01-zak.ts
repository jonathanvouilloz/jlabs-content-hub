/**
 * Avis de Zak Benayed (Eaux-Vives) : créé le 2025-04-25, modifié le 2026-09-30 pour citer Jasko.
 * Hors fenêtre Hermes (avis ancien) : répondu sur demande de Jonathan. Dry-run sans `--execute`.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { gmbReviews, projects } from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';
import { readGoogleReviewReply, putGoogleReviewReply } from '../src/lib/server/reviews/gmb-review-reply-api.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;
const EXECUTE = process.argv.includes('--execute');
const REVIEW_ID = 'AbFvOqmTkBWKzBDCb52msLQ0cDXXSXfgKui49R6BqtxQXTfgWrKQwB_Ao1Rn3tVfd2eC3IZey0YVgw';
const REPLY = "Merci Zak ! Le meilleur des meilleurs, Jasko va apprécier, on lui transmet. À très vite à Barber Concept Eaux-Vives !\n\nL'équipe Barber Concept";
const MENTIONS = JSON.stringify([{ name: 'Jasko', sentiment: 'positive' }]);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const project = (await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, 'barberconcept')))[0];
const row = (await db.select().from(gmbReviews).where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, REVIEW_ID))))[0];
if (!row || row.authorName !== 'Zak Benayed' || row.remoteReplyAt) throw new Error('Avis absent ou déjà répondu');
console.log(`→ ${REPLY.replace(/\n+/g, ' ⏎ ')}`);
if (!EXECUTE) { console.log('dry-run'); await pool.end(); process.exit(0); }

const request = { accessToken: await getGmbAccessToken(db), accountId: await getGmbAccountId(db), locationId: row.locationId, reviewId: row.reviewId };
const before = await readGoogleReviewReply(request);
if (before.kind !== 'present') throw new Error('Avis absent chez Google');
if (before.replyText) throw new Error(`Déjà une réponse chez Google : ${before.replyText.slice(0, 80)}`);
await putGoogleReviewReply(request, REPLY);
await db.update(gmbReviews).set({ draftReply: REPLY, repliedAt: toDbTimestamp(new Date()), mentionedEmployees: MENTIONS })
	.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, REVIEW_ID)));
for (let i = 0; i < 12; i++) {
	await new Promise((r) => setTimeout(r, 60000));
	const after = await readGoogleReviewReply(request);
	if (after.kind === 'present' && after.replyText?.startsWith(REPLY)) {
		await db.update(gmbReviews).set({ remoteReplyText: after.replyText, remoteReplyAt: after.replyAt ?? toDbTimestamp(new Date()) })
			.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, REVIEW_ID)));
		console.log(`✓ visible chez Google après ${i + 1} min`);
		break;
	}
}
await pool.end();
