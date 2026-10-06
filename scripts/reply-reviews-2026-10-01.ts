/**
 * Les 10 avis du 30/09 restés sans réponse après le passage Hermes du 2026-10-01 (plafond de 20 atteint).
 * Le 2★ de Mattia Borloz est répondu sur demande explicite de Jonathan (hors policy automatique).
 *
 * DRY-RUN PAR DÉFAUT. `--execute` : GET Google → PUT seulement si aucune réponse → GET de vérification.
 * Djulian a une proposition Hermes en `retry_eligible` : on la réconcilie d'abord par le hub, et si
 * Google n'a toujours rien, on publie SON texte puis on réconcilie — la proposition se clôt `verified`
 * au lieu de partir en `conflict` au prochain passage d'Hermes.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { gmbReviews, projects, reviewReplyProposals } from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';
import { readGoogleReviewReply, putGoogleReviewReply } from '../src/lib/server/reviews/gmb-review-reply-api.js';
import { reconcileAgentReviewReply } from '../src/lib/server/reviews/agent-review-service.js';
import { createAgentGoogleReplyDeps } from '../src/lib/server/reviews/agent-review-route.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent');
const EXECUTE = process.argv.includes('--execute');
const SIG = "\n\nL'équipe Barber Concept";
const DJULIAN_PROPOSAL = '3fdd12c8d3d91b0000c9dea8';

const REPLIES: Array<{ reviewId: string; authorName: string; reply: string | null }> = [
	{ reviewId: 'AbFvOqkQcX4T4SsBujN8Z34jzsGoLUYXj3G8w-kA0Og8BHVIaAt6GPINCmZA5Dki6SIqFNZVzfpeJg', authorName: 'Quentin Dupenloup', reply: `Merci Quentin pour ce retour aussi détaillé ! Prendre le temps de bien faire, c'est tout Thomas, il va être ravi de te lire. À très vite à Barber Concept Rive.${SIG}` },
	{ reviewId: 'AbFvOqkm_7-Ilr2qG43ftyvIkanfi2deF7vSpbx_GFwBVPU0bYdscF11Ci3jZgg6xlKDqGdLXeAJaQ', authorName: 'M (Cassis21)', reply: `Merci beaucoup pour ce message ! Bientôt un an de rendez-vous avec Mohammed, ça fait plaisir à lire, et on lui transmet tout de suite. À très vite à Barber Concept Jonction.${SIG}` },
	{ reviewId: 'AbFvOqky992mfblDA_-s3KEwxst-B-3PsxviUBGx1Ln3Oa7Pu4Fo482O9tcGjrrZL4_CGFThLUmZmQ', authorName: 'Polo Ralph', reply: `Merci ! On fait passer le message à Enzo. À bientôt à Barber Concept Cornavin 👌${SIG}` },
	{ reviewId: 'AbFvOqnyMZONnx7OljDnte4C4Hc-OFoTK6QtAbKRWhUD3YzaivMfNbJdYYpuvedVFzMSv6N7RfFLfQ', authorName: 'Lorenzo Gabrieli', reply: `Merci Lorenzo ! Une coupe de fou et un client bien accueilli, c'est exactement ce qu'on veut. Mohammed sera content de te lire, à très vite à Barber Concept Jonction.${SIG}` },
	{ reviewId: 'AbFvOqkAq8NXTpUyBEfcnCU1w7CdJR83v2HQbnWw5pVOd7J6JivgxwbUiJte6nvh1lFQ_JslX_uchQ', authorName: 'Sami BENHABBOUR', reply: `Merci Sami ! On transmet à Mohammed, et on t'attend pour la prochaine à Barber Concept Jonction.${SIG}` },
	{ reviewId: 'AbFvOqljIOwqtZM2G6LPEPWAmHsZSma4wT2IBS3RdYraSOUAZ1Lk5zb4sL9JfSz11oKkJUt1a_a00Q', authorName: 'richy pellet', reply: `Merci Richy ! Jessy va adorer le titre de goat 😄 À très vite à Barber Concept Rive.${SIG}` },
	{ reviewId: 'AbFvOqlvfxn9egrQYcjYcMGQGZhr1mJo-OuG4faOujTE8xjg4xRYpg46zN4fwfl1ZbIxWcAqk7qWxA', authorName: 'nuno mota', reply: `Merci Nuno ! On transmet à Muguy. À bientôt à Barber Concept Eaux-Vives !${SIG}` },
	{ reviewId: 'AbFvOqnnlHTKrO1YeDFJSYOT1VLOfhNh3svGcPOof6M9322NItMbvXuXGojr3RG-g_yF8D-M8FEh', authorName: 'j s', reply: `Merci pour les 5 étoiles ! On fait suivre à Ouss. À très vite à Barber Concept Rive.${SIG}` },
	{ reviewId: 'AbFvOqmjLNCqwxV6nCTguIa1Jiwj1QUICBfD1yzH9ZZlKEh_rZREANioEW9kC9YAFuuEzVF22Rz7Jw', authorName: 'Mattia Borloz', reply: `Bonjour Mattia, merci pour votre retour. Vous avez raison : quand on prend rendez-vous, c'est justement pour ne pas attendre, et 30 minutes de retard ne sont pas acceptables. Nous en parlons avec l'équipe de Barber Concept Sion pour que cela ne se reproduise pas. Écrivez-nous à contact@barberconcept.ch avec la date de votre passage, nous reviendrons vers vous personnellement.${SIG}` },
	// Texte repris de la proposition Hermes : c'est lui que la réconciliation attend.
	{ reviewId: 'AbFvOqmLJ4rt3oTYDuZXS7-HngYupYejbxwcAK_UZo_yBPC6R_Sb8T86lcb-bzcTkaMoKrac_7pC', authorName: 'Djulian', reply: null }
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const project = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, 'barberconcept')).then((r) => r[0]);
if (!project) throw new Error('Projet absent');

const djulian = await db.select().from(reviewReplyProposals).where(eq(reviewReplyProposals.id, DJULIAN_PROPOSAL)).then((r) => r[0]);
if (!djulian) throw new Error('Proposition Djulian absente');
REPLIES[REPLIES.length - 1].reply = djulian.replyText;

const rows = await db.select().from(gmbReviews).where(eq(gmbReviews.projectId, project.id));
const byId = new Map(rows.map((r) => [r.reviewId, r]));
for (const item of REPLIES) {
	const row = byId.get(item.reviewId);
	if (!row || row.authorName !== item.authorName) throw new Error(`Avis introuvable ou divergent : ${item.authorName}`);
	console.log(`- ${row.locationLabel} | ${row.rating}★ | ${item.authorName}${row.remoteReplyAt ? ' [déjà répondu, ignoré]' : ''}`);
	console.log(`  → ${item.reply!.replace(/\n+/g, ' ⏎ ')}`);
}
if (!EXECUTE) {
	console.log(JSON.stringify({ mode: 'dry-run', reviews: REPLIES.length, djulianProposal: djulian.state }));
	await pool.end();
	process.exit(0);
}

const reconcileDjulian = async () => {
	const deps = await createAgentGoogleReplyDeps({ db, projectSlug: 'barberconcept', proposalId: DJULIAN_PROPOSAL });
	return reconcileAgentReviewReply({ db, projectSlug: 'barberconcept', proposalId: DJULIAN_PROPOSAL, loadRemote: deps.loadRemote });
};

const accessToken = await getGmbAccessToken(db);
const accountId = await getGmbAccountId(db);
let published = 0;
let skipped = 0;
const failures: string[] = [];
for (const item of REPLIES) {
	const row = byId.get(item.reviewId)!;
	if (row.remoteReplyAt) { skipped++; continue; }
	const request = { accessToken, accountId, locationId: row.locationId, reviewId: row.reviewId };
	try {
		const isDjulian = item.authorName === 'Djulian';
		if (isDjulian) {
			const first = await reconcileDjulian();
			console.log(`  Djulian reconcile #1 : ${JSON.stringify(first)}`);
		}
		const before = await readGoogleReviewReply(request);
		if (before.kind === 'missing') throw new Error('avis absent chez Google');
		if (before.replyText) {
			console.log(`= ${item.authorName} : déjà une réponse chez Google, aucun PUT`);
			await db.update(gmbReviews)
				.set({ remoteReplyText: before.replyText, remoteReplyAt: before.replyAt ?? toDbTimestamp(new Date()) })
				.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, row.reviewId)));
			skipped++;
			continue;
		}
		await putGoogleReviewReply(request, item.reply!);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const after = await readGoogleReviewReply(request);
		const visible = after.kind === 'present' && after.replyText === item.reply;
		const now = toDbTimestamp(new Date());
		await db.update(gmbReviews)
			.set({
				draftReply: item.reply,
				repliedAt: now,
				...(visible ? { remoteReplyText: after.replyText, remoteReplyAt: after.replyAt ?? now } : {})
			})
			.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, row.reviewId)));
		if (isDjulian) console.log(`  Djulian reconcile #2 : ${JSON.stringify(await reconcileDjulian())}`);
		published++;
		console.log(`✓ ${item.authorName}${visible ? ' (vérifié chez Google)' : ' (PUT accepté, pas encore visible)'}`);
	} catch (error) {
		failures.push(`${item.authorName} : ${(error as Error).message.slice(0, 200)}`);
		console.error(`✗ ${item.authorName}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 350));
}
console.log(JSON.stringify({ mode: 'execute', published, skipped, failures }));
await pool.end();
process.exit(failures.length > 0 ? 1 : 0);
