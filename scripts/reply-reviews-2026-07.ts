/**
 * Répond aux avis Google de juillet 2026 restés sans réponse — barberconcept.
 *
 * DRY-RUN PAR DÉFAUT (comme `collect-reviews.ts`) : sans `--execute`, rien n'est écrit en base
 * et AUCUN appel Google ne part. Le dry-run se contente d'imprimer ce qui serait publié.
 *
 *   npx tsx scripts/reply-reviews-2026-07.ts                # dry-run, imprime le lot
 *   npx tsx scripts/reply-reviews-2026-07.ts --drafts-only  # écrit les brouillons en base, ne publie pas
 *   npx tsx scripts/reply-reviews-2026-07.ts --execute      # publie chez Google + marque en base
 *
 * ⚠️ `replyToReview` est un PUT : republier sur un avis qui a déjà une réponse la REMPLACE.
 *    C'est ce qui rend sûr le rattrapage des 11 avis dont l'état distant n'a jamais été relu.
 * ⚠️ Le rafraîchissement du jeton Google réécrit `gmb_settings.account_tokens` sans verrou.
 *    Ne pas lancer pendant le drain d'un `collect:gmb_reviews` (cron `tick`, catalogue 07:00).
 *
 * Le texte des réponses suit `projets/barberconcept/docs/{business/profile,brand/*,channels/gmb}.md` :
 * tutoiement, prénom du client, nom public du salon, signature « L'équipe Barber Concept ».
 * Aucune personne absente du tableau « Équipe publiable » n'est nommée (profile.md, règle absolue) —
 * d'où les réponses sans prénom sur les avis citant Issam, Santos et Heinok.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq, isNull, gte, lt } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { gmbReviews, projects } from '../src/lib/server/db/schema.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { REPLIES } from './reply-reviews-2026-07.data.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const DRAFTS_ONLY = args.includes('--drafts-only');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

const project = await db.query.projects.findFirst({ where: eq(projects.slug, 'barberconcept') });
if (!project) {
	console.error('Projet barberconcept introuvable. Abandon.');
	process.exit(1);
}

// La cible se relit en base au moment du run : un avis répondu entre-temps sort du lot.
const cibles = await db
	.select()
	.from(gmbReviews)
	.where(
		and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, '2026-07-01T00:00:00Z'),
			lt(gmbReviews.createTime, '2026-08-01T00:00:00Z'),
			isNull(gmbReviews.remoteReplyAt)
		)
	);

const parId = new Map(cibles.map((r) => [r.reviewId, r]));
console.log(`${cibles.length} avis sans réponse en base · ${REPLIES.length} réponses préparées`);

const manquants = cibles.filter((r) => !REPLIES.some((x) => x.reviewId === r.reviewId));
if (manquants.length > 0) {
	console.error(`\n⚠️  ${manquants.length} avis sans réponse préparée :`);
	for (const m of manquants) console.error(`   ${m.authorName} (${m.createTime.slice(0, 10)})`);
}

if (!EXECUTE && !DRAFTS_ONLY) {
	console.log('\n=== DRY-RUN — rien n\'est écrit, aucun appel Google ===\n');
	for (const r of REPLIES) {
		const avis = parId.get(r.reviewId);
		if (!avis) {
			console.log(`[DÉJÀ RÉPONDU, ignoré] ${r.reviewId.slice(-12)}`);
			continue;
		}
		console.log(`--- ${avis.locationLabel} | ${avis.rating}★ | ${avis.authorName}`);
		console.log(`    ${(avis.comment || '(pas de texte)').replace(/\s+/g, ' ').slice(0, 100)}`);
		console.log(`  → ${r.reply.replace(/\n+/g, ' ⏎ ')}\n`);
	}
	console.log(`Total : ${REPLIES.filter((r) => parId.has(r.reviewId)).length} réponses à publier.`);
	await pool.end();
	process.exit(0);
}

// --drafts-only : on pose le texte en base sans rien publier. Réversible, aucun effet public.
if (DRAFTS_ONLY) {
	let n = 0;
	for (const r of REPLIES) {
		if (!parId.has(r.reviewId)) continue;
		await db
			.update(gmbReviews)
			.set({ draftReply: r.reply })
			.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, r.reviewId)));
		n++;
	}
	console.log(`\n${n} brouillons écrits en base. Rien n'a été publié.`);
	await pool.end();
	process.exit(0);
}

// --execute : publication réelle chez Google.
const accessToken = await getGmbAccessToken(db);
const accountId = (await getGmbAccountId(db)).replace(/^accounts\//, '');

let ok = 0;
const echecs: { auteur: string; erreur: string }[] = [];

for (const r of REPLIES) {
	const avis = parId.get(r.reviewId);
	if (!avis) continue;

	const locId = avis.locationId.replace(/^locations\//, '');
	const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews/${avis.reviewId}/reply`;

	const res = await fetch(url, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ comment: r.reply })
	});

	if (!res.ok) {
		const texte = await res.text();
		echecs.push({ auteur: avis.authorName, erreur: `${res.status} ${texte.slice(0, 160)}` });
		console.error(`✗ ${avis.authorName} — ${res.status}`);
		continue;
	}

	// La réponse locale ET la réponse distante sont écrites depuis la MÊME réussite : c'est le
	// seul moment où l'on sait que les deux disent la même chose. `remoteReplyAt` sera de toute
	// façon réconcilié par la prochaine collecte.
	const maintenant = toDbTimestamp(new Date());
	await db
		.update(gmbReviews)
		.set({
			draftReply: r.reply,
			repliedAt: maintenant,
			remoteReplyText: r.reply,
			remoteReplyAt: maintenant
		})
		.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, r.reviewId)));

	ok++;
	console.log(`✓ ${avis.locationLabel} — ${avis.authorName}`);
	// Google tolère mal les rafales sur cet endpoint.
	await new Promise((r) => setTimeout(r, 350));
}

console.log(`\n${ok} réponses publiées · ${echecs.length} échecs`);
for (const e of echecs) console.error(`   ${e.auteur} : ${e.erreur}`);

await pool.end();
process.exit(echecs.length > 0 ? 1 : 0);
