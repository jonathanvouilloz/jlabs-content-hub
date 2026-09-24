/**
 * Préparation DB-only — avis Barber Concept des 1er et 2 septembre 2026.
 *
 * Par défaut : dry-run, aucune écriture et aucun appel Google.
 * --drafts-only : transaction DB uniquement ; enregistre les mentions confirmées
 * (y compris []) et les 8 brouillons. Les tokens non résolus restent NULL en base
 * mais sont conservés explicitement dans l'artefact `.data.ts`.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { REVIEW_PREPARATIONS } from './reply-reviews-2026-09-02.data.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');

const APPLY = process.argv.includes('--drafts-only');
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== '--drafts-only');
if (unexpectedArgs.length > 0) throw new Error(`Arguments non pris en charge : ${unexpectedArgs.join(', ')}`);

const START = Date.parse('2026-08-31T22:00:00Z');
const END = Date.parse('2026-09-02T22:00:00Z');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const project = await pool.query<{ id: string }>(
  "select id from seostats.projects where slug = 'barberconcept' limit 1"
).then((result) => result.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');

const ids = REVIEW_PREPARATIONS.map((item) => item.reviewId);
if (new Set(ids).size !== ids.length) throw new Error('Le lot contient des reviewId dupliqués.');
const expectedClassifiedRows = REVIEW_PREPARATIONS.filter((item) => item.mentions !== null).length;
const expectedMentionItems = REVIEW_PREPARATIONS.reduce(
  (total, item) => total + (item.mentions?.length ?? 0),
  0
);
const expectedUnresolvedRows = REVIEW_PREPARATIONS.filter((item) => item.mentions === null).length;

const reviews = await pool.query<{
  review_id: string;
  author_name: string;
  location_label: string;
  rating: number;
  comment: string;
  create_time: string;
  replied_at: string | null;
  remote_reply_at: string | null;
  draft_reply: string | null;
  mentioned_employees: string | null;
}>(
  `select review_id, author_name, location_label, rating, comment, create_time,
          replied_at, remote_reply_at, draft_reply, mentioned_employees
   from seostats.gmb_reviews
   where project_id = $1 and review_id = any($2::text[])
   order by create_time::timestamptz asc`,
  [project.id, ids]
).then((result) => result.rows);

if (reviews.length !== REVIEW_PREPARATIONS.length) {
  const found = new Set(reviews.map((review) => review.review_id));
  throw new Error(`Lot incomplet en base : absents=${ids.filter((id) => !found.has(id)).join(',')}`);
}

const byId = new Map(reviews.map((review) => [review.review_id, review]));
for (const item of REVIEW_PREPARATIONS) {
  const review = byId.get(item.reviewId)!;
  const createdAt = Date.parse(review.create_time);
  const digest = createHash('sha256').update(review.comment ?? '', 'utf8').digest('hex');
  if (
    createdAt < START ||
    createdAt >= END ||
    review.rating !== 5 ||
    review.author_name !== item.authorName ||
    review.location_label !== item.locationLabel ||
    review.create_time !== item.createTime ||
    digest !== item.commentSha256
  ) {
    throw new Error(`Snapshot inattendu pour ${item.reviewId}`);
  }
  if (review.replied_at !== null || review.remote_reply_at !== null) {
    throw new Error(`Avis déjà traité depuis l'audit : ${item.reviewId}`);
  }
  if (item.mentions === null && item.unresolvedMentionTokens.length === 0) {
    throw new Error(`Mention NULL sans token explicite : ${item.reviewId}`);
  }
  if (item.mentions !== null && item.unresolvedMentionTokens.length > 0) {
    throw new Error(`Avis à la fois classifié et non résolu : ${item.reviewId}`);
  }
}

console.log(APPLY ? '=== DRAFTS-ONLY — transaction DB, aucun appel Google ===' : '=== DRY-RUN — aucune écriture, aucun appel Google ===');
for (const item of REVIEW_PREPARATIONS) {
  const mentions = item.mentions === null
    ? `NON RÉSOLU: ${item.unresolvedMentionTokens.join(', ')}`
    : item.mentions.length === 0
      ? '[]'
      : item.mentions.map((mention) => `${mention.name}:${mention.sentiment}`).join(', ');
  console.log(`- ${item.locationLabel} | ${item.authorName} | mentions=${mentions}`);
  console.log(`  → ${item.reply.replace(/\n+/g, ' ⏎ ')}`);
}

if (!APPLY) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    reviews: REVIEW_PREPARATIONS.length,
    drafts: REVIEW_PREPARATIONS.length,
    classifiedRows: expectedClassifiedRows,
    mentionItems: expectedMentionItems,
    unresolvedRows: expectedUnresolvedRows
  }));
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let mentionsWritten = 0;
let mentionsAlreadyMatching = 0;
let unresolvedPreserved = 0;
let draftsWritten = 0;
let draftsAlreadyMatching = 0;
try {
  await client.query('begin');
  for (const item of REVIEW_PREPARATIONS) {
    const review = byId.get(item.reviewId)!;
    if (item.mentions === null) {
      if (review.mentioned_employees !== null) {
        throw new Error(`Mention non résolue déjà attribuée en base : ${item.reviewId}`);
      }
      unresolvedPreserved += 1;
    } else {
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
    }

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
    classified_rows: number;
    mention_items: number;
    unresolved_rows: number;
    rows_with_expected_draft: number;
    public_markers: number;
  }>(
    `select
       count(*) filter (where mentioned_employees is not null)::int as classified_rows,
       coalesce(sum(jsonb_array_length(mentioned_employees::jsonb)) filter (where mentioned_employees is not null), 0)::int as mention_items,
       count(*) filter (where mentioned_employees is null)::int as unresolved_rows,
       count(*) filter (where draft_reply is not null)::int as rows_with_expected_draft,
       count(*) filter (where replied_at is not null or remote_reply_at is not null)::int as public_markers
     from seostats.gmb_reviews
     where project_id = $1 and review_id = any($2::text[])`,
    [project.id, ids]
  ).then((result) => result.rows[0]);

  if (
    verification.classified_rows !== expectedClassifiedRows ||
    verification.mention_items !== expectedMentionItems ||
    verification.unresolved_rows !== expectedUnresolvedRows ||
    verification.rows_with_expected_draft !== REVIEW_PREPARATIONS.length ||
    verification.public_markers !== 0
  ) {
    throw new Error(`Vérification transactionnelle inattendue : ${JSON.stringify(verification)}`);
  }

  await client.query('commit');
  console.log(JSON.stringify({
    mode: 'drafts-only', mentionsWritten, mentionsAlreadyMatching, unresolvedPreserved,
    draftsWritten, draftsAlreadyMatching, verification
  }));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
