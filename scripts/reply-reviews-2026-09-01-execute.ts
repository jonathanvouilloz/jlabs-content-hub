/**
 * Publication des réponses Google + enregistrement des mentions — lot 2026-09-01.
 *
 * DRY-RUN PAR DÉFAUT : sans `--execute`, rien n'est écrit en base et AUCUN appel Google ne part.
 *   npx tsx scripts/reply-reviews-2026-09-01-execute.ts                # dry-run
 *   npx tsx scripts/reply-reviews-2026-09-01-execute.ts --execute      # PUT Google + marque DB
 *
 * ⚠️ `replyToReview` est un PUT : republier sur un avis qui a déjà une réponse la REMPLACE.
 * ⚠️ Le rafraîchissement du jeton Google réécrit `gmb_settings.account_tokens` sans verrou.
 *    Ne pas lancer pendant le drain d'un `collect:gmb_reviews` (cron `tick`, catalogue 07:00).
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray } from "drizzle-orm";
import ws from "ws";
import * as schema from "../src/lib/server/db/schema.js";
import { gmbReviews, projects } from "../src/lib/server/db/schema.js";
import { getGmbAccessToken, getGmbAccountId } from "../src/lib/server/gmb-auth.js";
import { toDbTimestamp } from "../src/lib/server/timestamps.js";
import { REVIEW_PREPARATIONS } from "./reply-reviews-2026-09-01.data.js";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL absent (.env). Abandon.");
  process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const unexpectedArgs = args.filter((arg) => arg !== "--execute");
if (unexpectedArgs.length > 0) throw new Error(`Arguments non pris en charge : ${unexpectedArgs.join(", ")}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

const project = await db
  .select({ id: projects.id })
  .from(projects)
  .where(eq(projects.slug, "barberconcept"))
  .limit(1)
  .then((rows) => rows[0]);
if (!project) {
  console.error("Projet barberconcept introuvable. Abandon.");
  process.exit(1);
}

const targetIds = REVIEW_PREPARATIONS.map((item) => item.reviewId);
const replyIds = REVIEW_PREPARATIONS.filter((item) => item.reply).map((item) => item.reviewId);
if (new Set(targetIds).size !== targetIds.length) throw new Error("reviewId dupliqués dans le lot.");

// La cible se relit en base au moment du run : un avis déjà répondu entre-temps sort du lot.
const cibles = await db
  .select()
  .from(gmbReviews)
  .where(and(eq(gmbReviews.projectId, project.id), inArray(gmbReviews.reviewId, targetIds)));

const parId = new Map(cibles.map((r) => [r.reviewId, r]));
const nonRepondus = cibles.filter((r) => r.repliedAt === null && r.remoteReplyAt === null);
const dejaTraites = cibles.filter((r) => r.repliedAt !== null || r.remoteReplyAt !== null);
console.log(
  `${nonRepondus.length}/${REVIEW_PREPARATIONS.length} avis encore en attente · ${dejaTraites.length} déjà traités (ignorés)`
);

if (!EXECUTE) {
  console.log("\n=== DRY-RUN — rien n'est écrit, aucun appel Google ===\n");
  let pub = 0;
  for (const item of REVIEW_PREPARATIONS) {
    const avis = parId.get(item.reviewId);
    if (!avis || avis.repliedAt !== null || avis.remoteReplyAt !== null) {
      console.log(`[déjà traité, ignoré] ${item.reviewId.slice(-12)}`);
      continue;
    }
    pub++;
    const mentions = item.mentions.length > 0
      ? item.mentions.map((m) => `${m.name}:${m.sentiment}`).join(", ")
      : "[]";
    console.log(`--- ${avis.locationLabel} | ${avis.rating}★ | ${avis.authorName} | mentions=${mentions}`);
    console.log(`    ${(avis.comment || "(pas de texte)").replace(/\s+/g, " ").slice(0, 110)}`);
    if (item.reply) console.log(`  → ${item.reply.replace(/\n+/g, " ⏎ ")}\n`);
  }
  console.log(`Total : ${pub} réponses à publier.`);
  await pool.end();
  process.exit(0);
}

// --execute : publication réelle chez Google + marquage DB + mentions.
const accessToken = await getGmbAccessToken(db);
const accountId = (await getGmbAccountId(db)).replace(/^accounts\//, "");

let ok = 0;
const echecs: { auteur: string; erreur: string }[] = [];

for (const item of REVIEW_PREPARATIONS) {
  const avis = parId.get(item.reviewId);
  if (!avis || avis.repliedAt !== null || avis.remoteReplyAt !== null) continue;
  if (!item.reply) continue;

  const locId = avis.locationId.replace(/^locations\//, "");
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews/${avis.reviewId}/reply`;

  const res = await fetch(url, {
    method: "PUT",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ comment: item.reply })
  });

  if (!res.ok) {
    const texte = await res.text();
    echecs.push({ auteur: avis.authorName, erreur: `${res.status} ${texte.slice(0, 160)}` });
    console.error(`✗ ${avis.authorName} — ${res.status}`);
    continue;
  }

  // La réponse locale ET la réponse distante sont écrites depuis la MÊME réussite.
  const maintenant = toDbTimestamp(new Date());
  await db
    .update(gmbReviews)
    .set({
      draftReply: item.reply,
      repliedAt: maintenant,
      remoteReplyText: item.reply,
      remoteReplyAt: maintenant,
      mentionedEmployees: JSON.stringify(item.mentions)
    })
    .where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, item.reviewId)));

  ok++;
  console.log(`✓ ${avis.locationLabel} — ${avis.authorName}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

console.log(`\n${ok} réponses publiées · ${echecs.length} échecs`);
for (const e of echecs) console.error(`   ${e.auteur} : ${e.erreur}`);

await pool.end();
process.exit(echecs.length > 0 ? 1 : 0);
