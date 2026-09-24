/**
 * Résolution DB-only des deux mentions Ilias.
 * Par défaut : dry-run. --drafts-only applique la mention et remplace uniquement
 * les brouillons génériques encore non publiés.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { ILIAS_REVIEW_PREPARATIONS } from './reply-reviews-2026-09-02-ilias.data.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');
const APPLY = process.argv.includes('--drafts-only');
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== '--drafts-only');
if (unexpectedArgs.length > 0) throw new Error(`Arguments non pris en charge : ${unexpectedArgs.join(', ')}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{ id: string }>(
  "select id from seostats.projects where slug = 'barberconcept' limit 1"
).then((result) => result.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');
const ids = ILIAS_REVIEW_PREPARATIONS.map((item) => item.reviewId);

const rows = await pool.query<{
  review_id: string;
  author_name: string;
  location_label: string;
  create_time: string;
  comment: string;
  mentioned_employees: string | null;
  draft_reply: string | null;
  replied_at: string | null;
  remote_reply_at: string | null;
}>(
  `select review_id, author_name, location_label, create_time, comment,
          mentioned_employees, draft_reply, replied_at, remote_reply_at
   from seostats.gmb_reviews
   where project_id = $1 and review_id = any($2::text[])`,
  [project.id, ids]
).then((result) => result.rows);
if (rows.length !== ids.length) throw new Error(`Lot local incomplet : ${rows.length}/${ids.length}.`);

const byId = new Map(rows.map((row) => [row.review_id, row]));
for (const item of ILIAS_REVIEW_PREPARATIONS) {
  const row = byId.get(item.reviewId)!;
  const digest = createHash('sha256').update(row.comment ?? '', 'utf8').digest('hex');
  const expectedMentions = JSON.stringify(item.mentions);
  if (
    row.author_name !== item.authorName ||
    row.location_label !== item.locationLabel ||
    row.create_time !== item.createTime ||
    digest !== item.commentSha256
  ) throw new Error(`Snapshot divergent : ${item.reviewId}`);
  if (row.replied_at !== null || row.remote_reply_at !== null) {
    throw new Error(`Avis déjà traité publiquement : ${item.reviewId}`);
  }
  if (row.mentioned_employees !== null && row.mentioned_employees !== expectedMentions) {
    throw new Error(`Mention existante différente : ${item.reviewId}`);
  }
  if (row.draft_reply !== item.previousDraft && row.draft_reply !== item.reply) {
    throw new Error(`Brouillon existant différent : ${item.reviewId}`);
  }
}

console.log(APPLY ? '=== DRAFTS-ONLY ILIAS — aucune publication Google ===' : '=== DRY-RUN ILIAS — aucune écriture ===');
for (const item of ILIAS_REVIEW_PREPARATIONS) {
  console.log(`- ${item.authorName} | mention=Ilias:positive`);
  console.log(`  → ${item.reply.replace(/\n+/g, ' ⏎ ')}`);
}

if (!APPLY) {
  console.log(JSON.stringify({ mode: 'dry-run', reviews: ids.length, mentions: ids.length, drafts: ids.length }));
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let updated = 0;
let alreadyMatching = 0;
try {
  await client.query('begin');
  for (const item of ILIAS_REVIEW_PREPARATIONS) {
    const row = byId.get(item.reviewId)!;
    const expectedMentions = JSON.stringify(item.mentions);
    if (row.mentioned_employees === expectedMentions && row.draft_reply === item.reply) {
      alreadyMatching += 1;
      continue;
    }
    const result = await client.query(
      `update seostats.gmb_reviews
       set mentioned_employees = $1, draft_reply = $2
       where project_id = $3 and review_id = $4
         and mentioned_employees is null and draft_reply = $5
         and replied_at is null and remote_reply_at is null`,
      [expectedMentions, item.reply, project.id, item.reviewId, item.previousDraft]
    );
    if (result.rowCount !== 1) throw new Error(`Écriture concurrente : ${item.reviewId}`);
    updated += 1;
  }

  const verified = await client.query<{ count: number }>(
    `select count(*)::int as count
     from seostats.gmb_reviews r
     join unnest($2::text[], $3::text[], $4::text[]) as expected(review_id, mentions, draft)
       on expected.review_id = r.review_id
     where r.project_id = $1
       and r.mentioned_employees = expected.mentions
       and r.draft_reply = expected.draft
       and r.replied_at is null and r.remote_reply_at is null`,
    [
      project.id,
      ids,
      ILIAS_REVIEW_PREPARATIONS.map((item) => JSON.stringify(item.mentions)),
      ILIAS_REVIEW_PREPARATIONS.map((item) => item.reply)
    ]
  ).then((result) => result.rows[0]?.count ?? 0);
  if (verified !== ids.length) throw new Error(`Vérification transactionnelle : ${verified}/${ids.length}.`);
  await client.query('commit');
  console.log(JSON.stringify({ mode: 'drafts-only', updated, alreadyMatching, verified }));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
