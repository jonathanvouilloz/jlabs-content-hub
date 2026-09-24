/**
 * Prépare les réponses et enregistre les mentions employés du lot 2026-08-31.
 *
 * Par défaut : dry-run, aucune écriture et aucun appel Google.
 * --drafts-only : transaction DB uniquement ; écrit les mentions par avis et les
 * brouillons des avis encore en attente. Ce script n'importe volontairement aucun
 * client Google et ne peut donc rien publier.
 */
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { REVIEW_PREPARATIONS } from './reply-reviews-2026-08-31.data.js';

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

const ids = REVIEW_PREPARATIONS.map((item) => item.reviewId);
const replyIds = REVIEW_PREPARATIONS.filter((item) => item.reply).map((item) => item.reviewId);
const expectedMentionItems = REVIEW_PREPARATIONS.reduce((total, item) => total + item.mentions.length, 0);
if (new Set(ids).size !== ids.length) throw new Error('Le lot contient des reviewId dupliqués.');

const reviews = await pool.query<{
  review_id: string;
  author_name: string;
  location_label: string;
  rating: number;
  create_time: string;
  replied_at: string | null;
  remote_reply_at: string | null;
  draft_reply: string | null;
  mentioned_employees: string | null;
}>(
  `select review_id, author_name, location_label, rating, create_time,
          replied_at, remote_reply_at, draft_reply, mentioned_employees
   from seostats.gmb_reviews
   where project_id = $1 and review_id = any($2::text[])
   order by create_time::timestamptz asc`,
  [project.id, ids]
).then((result) => result.rows);

if (reviews.length !== REVIEW_PREPARATIONS.length) {
  const found = new Set(reviews.map((review) => review.review_id));
  const missing = ids.filter((id) => !found.has(id));
  throw new Error(`Lot incomplet en base : ${reviews.length}/${REVIEW_PREPARATIONS.length}; absents=${missing.join(',')}`);
}

const byId = new Map(reviews.map((review) => [review.review_id, review]));
for (const item of REVIEW_PREPARATIONS) {
  const review = byId.get(item.reviewId);
  if (!review) throw new Error(`Avis absent : ${item.reviewId}`);
  const createdAt = new Date(review.create_time).getTime();
  const inWindow = createdAt >= Date.parse('2026-07-31T22:00:00Z') && createdAt < Date.parse('2026-08-31T22:00:00Z');
  if (!inWindow || review.rating !== 5 || review.author_name !== item.authorName || review.location_label !== item.locationLabel) {
    throw new Error(`Snapshot inattendu pour ${item.reviewId}: ${review.author_name} / ${review.location_label} / ${review.rating}★ / ${review.create_time}`);
  }
  if (item.reply && (review.replied_at !== null || review.remote_reply_at !== null)) {
    throw new Error(`Candidat de réponse déjà traité depuis l'audit : ${item.reviewId}`);
  }
}

console.log(APPLY ? '=== DRAFTS-ONLY — transaction DB, aucun appel Google ===' : '=== DRY-RUN — aucune écriture, aucun appel Google ===');
for (const item of REVIEW_PREPARATIONS) {
  const review = byId.get(item.reviewId)!;
  const state = review.replied_at === null && review.remote_reply_at === null ? 'pending' : 'answered';
  const mentions = item.mentions.length > 0
    ? item.mentions.map((mention) => `${mention.name}:${mention.sentiment}`).join(', ')
    : '[]';
  console.log(`- ${item.locationLabel} | ${item.authorName} | ${state} | mentions=${mentions}${item.reply ? ' | brouillon=oui' : ''}`);
  if (item.reply) console.log(`  → ${item.reply.replace(/\n+/g, ' ⏎ ')}`);
}

if (!APPLY) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    reviews: REVIEW_PREPARATIONS.length,
    replies: replyIds.length,
    mentions: expectedMentionItems
  }));
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let mentionsWritten = 0;
let mentionsAlreadyMatching = 0;
let draftsWritten = 0;
let draftsAlreadyMatching = 0;
try {
  await client.query('begin');
  for (const item of REVIEW_PREPARATIONS) {
    const review = byId.get(item.reviewId)!;
    const expectedMentions = JSON.stringify(item.mentions);
    if (review.mentioned_employees === null) {
      const result = await client.query(
        `update seostats.gmb_reviews set mentioned_employees = $1
         where project_id = $2 and review_id = $3 and mentioned_employees is null`,
        [expectedMentions, project.id, item.reviewId]
      );
      if (result.rowCount !== 1) throw new Error(`Écriture concurrente des mentions : ${item.reviewId}`);
      mentionsWritten += 1;
    } else if (review.mentioned_employees === expectedMentions) {
      mentionsAlreadyMatching += 1;
    } else {
      throw new Error(`Mentions déjà présentes et différentes : ${item.reviewId}`);
    }

    if (!item.reply) continue;
    if (review.draft_reply === null) {
      const result = await client.query(
        `update seostats.gmb_reviews set draft_reply = $1
         where project_id = $2 and review_id = $3
           and draft_reply is null and replied_at is null and remote_reply_at is null`,
        [item.reply, project.id, item.reviewId]
      );
      if (result.rowCount !== 1) throw new Error(`Écriture concurrente du brouillon : ${item.reviewId}`);
      draftsWritten += 1;
    } else if (review.draft_reply === item.reply) {
      draftsAlreadyMatching += 1;
    } else {
      throw new Error(`Brouillon déjà présent et différent : ${item.reviewId}`);
    }
  }

  const verification = await client.query<{
    rows_with_mentions: number;
    mention_items: number;
    rows_with_expected_draft: number;
    public_markers: number;
  }>(
    `select
       count(*) filter (where mentioned_employees is not null)::int as rows_with_mentions,
       coalesce(sum(jsonb_array_length(mentioned_employees::jsonb)) filter (where mentioned_employees is not null), 0)::int as mention_items,
       count(*) filter (where review_id = any($2::text[]) and draft_reply is not null)::int as rows_with_expected_draft,
       count(*) filter (where review_id = any($2::text[]) and (replied_at is not null or remote_reply_at is not null))::int as public_markers
     from seostats.gmb_reviews
     where project_id = $1 and review_id = any($3::text[])`,
    [project.id, replyIds, ids]
  ).then((result) => result.rows[0]);

  if (
    verification.rows_with_mentions !== REVIEW_PREPARATIONS.length ||
    verification.mention_items !== expectedMentionItems ||
    verification.rows_with_expected_draft !== replyIds.length ||
    verification.public_markers !== 0
  ) {
    throw new Error(`Vérification transactionnelle inattendue : ${JSON.stringify(verification)}`);
  }
  await client.query('commit');
  console.log(JSON.stringify({
    mode: 'drafts-only',
    mentionsWritten,
    mentionsAlreadyMatching,
    draftsWritten,
    draftsAlreadyMatching,
    verification
  }));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
