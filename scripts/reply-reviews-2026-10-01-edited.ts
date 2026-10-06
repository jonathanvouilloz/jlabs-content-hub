/**
 * Anciens avis modifiés en septembre 2026 (décision Jonathan, 2026-10-01) : on met à jour les réponses,
 * mais une modification ne crée JAMAIS de mention (seul le mois de création compte).
 * - Jawed (Sion) : passé en 2★ critique, la réponse en ligne remerciait → REMPLACÉE (PUT).
 * - Achille Bossart (Lausanne) : cite désormais Giuseppe, la réponse disait Raphaël → REMPLACÉE.
 * - La Haine (Jonction) : sans réponse.
 * + Zak Benayed : retrait de la mention Jasko posée par reply-reviews-2026-10-01-zak.ts.
 * Dry-run sans `--execute`.
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
const SIG = "\n\nL'équipe Barber Concept";
const ITEMS: Array<{ authorName: string; currentReplyPrefix: string | null; reply: string }> = [
	{ authorName: 'Jawed', currentReplyPrefix: 'Merci beaucoup Jawed pour votre avis', reply: `Bonjour Jawed, merci d'avoir pris le temps de mettre à jour votre avis. Montrer une photo et repartir avec une coupe différente, trop courte devant alors que vous aviez demandé l'inverse : ce n'est pas l'expérience qu'on veut offrir à Barber Concept Sion, et on le prend au sérieux. Écrivez-nous à contact@barberconcept.ch avec la date de votre passage, on aimerait trouver une solution avec vous.${SIG}` },
	{ authorName: 'Achille Bossart', currentReplyPrefix: 'Merci Achille pour ce retour détaillé', reply: `Merci Achille pour ce retour détaillé ! Un taper propre et précis, exactement comme tu le voulais : Giuseppe va être ravi de te lire. À très vite à Barber Concept Lausanne !${SIG}` },
	{ authorName: 'La Haine', currentReplyPrefix: null, reply: `Merci pour ce message ! HK va être touché de lire ça, on lui transmet. À très vite à Barber Concept Jonction ❤️${SIG}` }
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const project = (await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, 'barberconcept')))[0];
const rows = await db.select().from(gmbReviews).where(eq(gmbReviews.projectId, project.id));
const targets = ITEMS.map((item) => {
	const matches = rows.filter((r) => r.authorName === item.authorName && r.remoteUpdateAt?.startsWith('2026-09'));
	if (matches.length !== 1) throw new Error(`Avis ambigu ou absent : ${item.authorName} (${matches.length})`);
	console.log(`- ${item.authorName} | ${matches[0].locationLabel} | ${matches[0].rating}★`);
	console.log(`  → ${item.reply.replace(/\n+/g, ' ⏎ ')}`);
	return { item, row: matches[0] };
});
const zak = rows.find((r) => r.authorName === 'Zak Benayed');
console.log(`- Zak Benayed : mentions ${zak?.mentionedEmployees ?? 'NULL'} -> NULL`);
if (!EXECUTE) { console.log('dry-run'); await pool.end(); process.exit(0); }

await db.update(gmbReviews).set({ mentionedEmployees: null })
	.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, zak!.reviewId)));

const accessToken = await getGmbAccessToken(db);
const accountId = await getGmbAccountId(db);
const sent: typeof targets = [];
for (const target of targets) {
	const request = { accessToken, accountId, locationId: target.row.locationId, reviewId: target.row.reviewId };
	const before = await readGoogleReviewReply(request);
	if (before.kind !== 'present') throw new Error(`Avis absent chez Google : ${target.item.authorName}`);
	const expected = target.item.currentReplyPrefix;
	const ok = expected === null ? before.replyText === null : before.replyText?.startsWith(expected);
	if (!ok) { console.error(`✗ ${target.item.authorName} : réponse en ligne inattendue, rien publié`); continue; }
	await putGoogleReviewReply(request, target.item.reply);
	await db.update(gmbReviews).set({ draftReply: target.item.reply, repliedAt: toDbTimestamp(new Date()) })
		.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, target.row.reviewId)));
	sent.push(target);
	console.log(`↑ ${target.item.authorName} : PUT accepté`);
}
for (let i = 0; i < 12 && sent.length > 0; i++) {
	await new Promise((r) => setTimeout(r, 60000));
	for (const target of [...sent]) {
		const after = await readGoogleReviewReply({ accessToken, accountId, locationId: target.row.locationId, reviewId: target.row.reviewId });
		if (after.kind === 'present' && after.replyText?.startsWith(target.item.reply)) {
			await db.update(gmbReviews).set({ remoteReplyText: after.replyText, remoteReplyAt: after.replyAt ?? toDbTimestamp(new Date()) })
				.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, target.row.reviewId)));
			sent.splice(sent.indexOf(target), 1);
			console.log(`✓ ${target.item.authorName} visible après ${i + 1} min`);
		}
	}
}
if (sent.length) console.log(`⚠ pas encore visibles : ${sent.map((t) => t.item.authorName).join(', ')}`);
await pool.end();
