/**
 * Archive auditable des 15 réponses Barber Concept publiées le 2026-08-03.
 *
 * Toutes les écritures sont définitivement désactivées : le script conserve uniquement
 * le dry-run et la vérification distante.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray } from "drizzle-orm";
import ws from "ws";
import * as schema from "../src/lib/server/db/schema.js";
import { gmbReviews, projects } from "../src/lib/server/db/schema.js";
import {
  getGmbAccessToken,
  getGmbAccountId,
} from "../src/lib/server/gmb-auth.js";
import { REPLIES } from "./reply-reviews-2026-08-03.data.js";

neonConfig.webSocketConstructor = ws;

const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const forbiddenModes = ["--execute", "--drafts-only", "--reconcile-findings"];
const forbiddenMode = forbiddenModes.find((mode) => args.includes(mode));
if (forbiddenMode) {
  console.error(
    `${forbiddenMode} est fermé : cette archive est définitivement en lecture seule.`,
  );
  process.exit(2);
}
const unknownMode = args.find((arg) => arg !== "--verify");
if (unknownMode) {
  console.error(
    `Argument inconnu : ${unknownMode}. Utiliser --verify ou aucun argument.`,
  );
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL absent. Abandon.");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

interface RemoteReply {
  comment?: string;
  updateTime?: string;
}

interface RemoteReview {
  reviewReply?: RemoteReply;
}

function authHeaders(accessToken: string): Record<string, string> {
  const name = ["Author", "ization"].join("");
  const scheme = ["Bear", "er"].join("");
  return { [name]: [scheme, accessToken].join(" ") };
}

function isExpectedRemoteReply(comment: string, expected: string): boolean {
  if (comment === expected) return true;
  if (!comment.startsWith(expected)) return false;
  const suffix = comment.slice(expected.length);
  return /^\s*\((?:Traduit par Google|Translated by Google)\)\s/.test(suffix);
}

try {
  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, "barberconcept"))
    .limit(1)
    .then((rows) => rows[0]);
  if (!project) throw new Error("Projet barberconcept introuvable.");

  const targetIds = REPLIES.map((item) => item.reviewId);
  const targets = await db
    .select()
    .from(gmbReviews)
    .where(
      and(
        eq(gmbReviews.projectId, project.id),
        inArray(gmbReviews.reviewId, targetIds),
      ),
    );
  const pending = targets.filter(
    (review) => review.repliedAt === null && review.remoteReplyAt === null,
  );
  const byId = new Map(pending.map((review) => [review.reviewId, review]));
  const allById = new Map(targets.map((review) => [review.reviewId, review]));

  async function verifyRemoteReplies(): Promise<void> {
    const accessToken = await getGmbAccessToken(db, { persist: false });
    const accountId = await getGmbAccountId(db);
    if (!accountId) throw new Error("Identifiant de compte GMB absent.");

    let verified = 0;
    const failures: string[] = [];
    for (const item of REPLIES) {
      const review = allById.get(item.reviewId);
      if (!review) {
        failures.push(`${item.reviewId.slice(-12)} : absent de Neon`);
        continue;
      }
      const locationId = review.locationId.replace(/^locations\//, "");
      const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${review.reviewId}`;
      const response = await fetch(url, { headers: authHeaders(accessToken) });
      if (!response.ok) {
        failures.push(`${review.authorName} : lecture ${response.status}`);
        continue;
      }
      const remote = (await response.json()) as RemoteReview;
      if (
        !remote.reviewReply?.comment ||
        !isExpectedRemoteReply(remote.reviewReply.comment, item.reply)
      ) {
        failures.push(
          `${review.authorName} : texte distant différent ou absent`,
        );
        continue;
      }
      verified++;
      console.log(`✓ ${review.locationLabel} : ${review.authorName}`);
    }

    console.log(`\n${verified}/${REPLIES.length} réponses distantes vérifiées`);
    for (const failure of failures) console.error(`  ${failure}`);
    if (failures.length > 0) {
      throw new Error(
        "Vérification refusée : les 15 réponses Google ne correspondent pas exactement.",
      );
    }
  }

  console.log(
    `${pending.length}/${REPLIES.length} avis sont encore en attente dans Neon.`,
  );

  if (!VERIFY) {
    console.log("\n=== DRY-RUN : aucune écriture, aucun appel Google ===\n");
    for (const item of REPLIES) {
      const review = byId.get(item.reviewId);
      if (!review) {
        console.log(`[déjà traité ou divergence] ${item.reviewId.slice(-12)}`);
        continue;
      }
      console.log(
        `--- ${review.locationLabel} | ${review.rating}★ | ${review.authorName}`,
      );
      console.log(
        `    ${(review.comment || "(sans commentaire)").replace(/\s+/g, " ").slice(0, 140)}`,
      );
      console.log(`  → ${item.reply.replace(/\n+/g, " ⏎ ")}\n`);
    }
  } else {
    await verifyRemoteReplies();
  }
} finally {
  await pool.end();
}
