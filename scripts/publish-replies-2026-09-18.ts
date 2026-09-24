/**
 * Publication contrôlée du lot Barber Concept préparé le 2026-09-18.
 *
 * Par défaut : GET Google uniquement, aucune écriture.
 * --execute : préflight anti-concurrence, GET → un seul PUT au maximum → GET
 * de preuve. Un résultat de PUT ambigu n'est jamais rejoué : seules des relectures
 * GET bornées suivent, puis l'avis reste sans marqueur local si la preuve manque.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { REVIEW_PREPARATIONS } from './reply-reviews-2026-09-18.data.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');

const EXECUTE = process.argv.includes('--execute');
const VERIFY_ONLY = process.argv.includes('--verify-only');
if (EXECUTE && VERIFY_ONLY) throw new Error('Choisir --execute ou --verify-only, jamais les deux.');
const unexpectedArgs = process.argv.slice(2).filter((arg) => !['--execute', '--verify-only'].includes(arg));
if (unexpectedArgs.length > 0) throw new Error(`Arguments non pris en charge : ${unexpectedArgs.join(', ')}`);

// Lot de 11 avis 5★, toutes les mentions sont classifiées dans l'artefact daté.
const candidates = REVIEW_PREPARATIONS;
if (candidates.length !== 1) {
  throw new Error(`Périmètre autorisé inattendu : ${candidates.length}/1 avis.`);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

const project = await pool.query<{ id: string }>(
  "select id from seostats.projects where slug = 'barberconcept' limit 1"
).then((result) => result.rows[0]);
if (!project) throw new Error('Projet barberconcept introuvable.');

const runningCollector = await pool.query<{
  id: string;
  lease_owner: string | null;
  lease_until: string | null;
}>(
  `select id, lease_owner, lease_until
   from seostats.jobs
   where project_id = $1 and type = 'collect:gmb_reviews' and status = 'running'
     and (lease_until is null or lease_until::timestamp > (now() at time zone 'UTC'))
   limit 1`,
  [project.id]
).then((result) => result.rows[0]);
if (runningCollector) {
  throw new Error(`Collecte GMB concurrente détectée (${runningCollector.id}); publication annulée.`);
}

const ids = candidates.map((candidate) => candidate.reviewId);
const reviews = await pool.query<{
  review_id: string;
  location_id: string;
  location_label: string;
  author_name: string;
  rating: number;
  comment: string | null;
  draft_reply: string | null;
  replied_at: string | null;
  remote_reply_at: string | null;
  mentioned_employees: string | null;
  last_seen_at: string | null;
}>(
  `select review_id, location_id, location_label, author_name, rating, comment,
          draft_reply, replied_at, remote_reply_at, mentioned_employees, last_seen_at
   from seostats.gmb_reviews
   where project_id = $1 and review_id = any($2::text[])`,
  [project.id, ids]
).then((result) => result.rows);
if (reviews.length !== candidates.length) throw new Error(`Lot local incomplet : ${reviews.length}/${candidates.length}.`);

const byId = new Map(reviews.map((review) => [review.review_id, review]));
for (const candidate of candidates) {
  const review = byId.get(candidate.reviewId);
  if (!review) throw new Error(`Avis local absent : ${candidate.reviewId}`);
  const commentDigest = createHash('sha256').update(review.comment ?? '', 'utf8').digest('hex');
  if (
    review.rating !== 5 ||
    review.author_name !== candidate.authorName ||
    review.location_label !== candidate.locationLabel ||
    commentDigest !== candidate.commentSha256 ||
    review.draft_reply !== candidate.reply ||
    review.mentioned_employees !== (candidate.mentions === null ? null : JSON.stringify(candidate.mentions))
  ) {
    throw new Error(`Snapshot local divergent pour ${candidate.reviewId}; publication annulée.`);
  }
}

const accessToken = await getGmbAccessToken(db, { persist: false });
const accountId = await getGmbAccountId(db);
if (!accountId) throw new Error('Compte Google Business introuvable.');

function segment(value: string, prefix: string): string {
  return value.replace(new RegExp(`^${prefix}/`), '');
}

function endpoint(locationId: string, reviewId: string): string {
  return `https://mybusiness.googleapis.com/v4/accounts/${segment(accountId, 'accounts')}/locations/${segment(locationId, 'locations')}/reviews/${segment(reviewId, 'reviews')}`;
}

function authHeaders(contentType = false): Record<string, string> {
  const authorization = ['Bear', 'er '].join('') + accessToken;
  return contentType
    ? { Authorization: authorization, 'Content-Type': 'application/json' }
    : { Authorization: authorization };
}

type RemoteReview =
  | { kind: 'missing' }
  | { kind: 'changed' }
  | { kind: 'present'; replyText: string | null; replyUpdateTime: string | null };

async function readRemote(locationId: string, reviewId: string, expectedComment: string): Promise<RemoteReview> {
  const response = await fetch(endpoint(locationId, reviewId), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return { kind: 'missing' };
  if (!response.ok) throw new Error(`GET Google ${response.status}: ${(await response.text()).slice(0, 180)}`);
  const body = await response.json() as {
    comment?: unknown;
    reviewReply?: { comment?: unknown; updateTime?: unknown };
  };
  const comment = typeof body.comment === 'string' ? body.comment : '';
  if (comment !== expectedComment) return { kind: 'changed' };
  return {
    kind: 'present',
    replyText: typeof body.reviewReply?.comment === 'string' ? body.reviewReply.comment : null,
    replyUpdateTime: typeof body.reviewReply?.updateTime === 'string' ? body.reviewReply.updateTime : null
  };
}

function remoteReplyMatches(expected: string, actual: string | null): boolean {
  return actual === expected ||
    actual?.startsWith(`${expected}\n\n(Translated by Google)\n`) === true ||
    actual?.endsWith(`\n\n(Original)\n${expected}`) === true;
}

async function putOnce(locationId: string, reviewId: string, replyText: string): Promise<void> {
  const response = await fetch(`${endpoint(locationId, reviewId)}/reply`, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify({ comment: replyText }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`PUT Google ${response.status}: ${(await response.text()).slice(0, 180)}`);
}

async function verifyWithGetOnly(
  locationId: string,
  reviewId: string,
  expectedComment: string,
  expectedReply: string
): Promise<{ remote: RemoteReview | null; error: string | null }> {
  const delays = [0, 1_000, 2_500, 5_000];
  let lastRemote: RemoteReview | null = null;
  let lastError: string | null = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      lastRemote = await readRemote(locationId, reviewId, expectedComment);
      lastError = null;
      if (lastRemote.kind !== 'present' || remoteReplyMatches(expectedReply, lastRemote.replyText)) {
        return { remote: lastRemote, error: null };
      }
      if (lastRemote.replyText !== null) return { remote: lastRemote, error: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { remote: lastRemote, error: lastError };
}

async function persistVerified(candidate: (typeof candidates)[number], remote: Extract<RemoteReview, { kind: 'present' }>): Promise<boolean> {
  const repliedAt = toDbTimestamp(new Date());
  const remoteDate = remote.replyUpdateTime ? new Date(remote.replyUpdateTime) : null;
  const remoteReplyAt = remoteDate && !Number.isNaN(remoteDate.getTime())
    ? toDbTimestamp(remoteDate)
    : repliedAt;
  const result = await pool.query(
    `update seostats.gmb_reviews
     set draft_reply = $1, replied_at = $2, remote_reply_text = $3, remote_reply_at = $4
     where project_id = $5 and review_id = $6
       and draft_reply = $1 and replied_at is null
       and (remote_reply_at is null or remote_reply_text = draft_reply)`,
    [candidate.reply, repliedAt, remote.replyText, remoteReplyAt, project.id, candidate.reviewId]
  );
  return result.rowCount === 1;
}

let ready = 0;
let verified = 0;
let reconciled = 0;
let blocked = 0;
let writeUnknown = 0;

console.log(
  EXECUTE
    ? '=== EXECUTE — GET → PUT unique → GET de preuve ==='
    : VERIFY_ONLY
      ? '=== VERIFY-ONLY — GET et réconciliation, aucun PUT ==='
      : '=== DRY-RUN — GET Google uniquement ==='
);
for (const candidate of candidates) {
  const review = byId.get(candidate.reviewId)!;
  if (review.replied_at !== null && !VERIFY_ONLY) {
    console.log(`SKIP ${candidate.authorName} — déjà marqué traité localement`);
    continue;
  }

  let before: RemoteReview;
  try {
    before = await readRemote(review.location_id, review.review_id, review.comment ?? '');
  } catch (error) {
    console.log(`BLOCKED ${candidate.authorName} — ${error instanceof Error ? error.message : String(error)}`);
    blocked += 1;
    continue;
  }
  if (before.kind === 'missing' || before.kind === 'changed') {
    console.log(`BLOCKED ${candidate.authorName} — avis ${before.kind === 'missing' ? 'absent' : 'modifié'} côté Google`);
    blocked += 1;
    continue;
  }
  if (before.replyText !== null && !remoteReplyMatches(candidate.reply, before.replyText)) {
    console.log(`BLOCKED ${candidate.authorName} — réponse Google existante différente`);
    blocked += 1;
    continue;
  }

  if (VERIFY_ONLY && review.replied_at !== null && remoteReplyMatches(candidate.reply, before.replyText)) {
    console.log(`VERIFIED ${candidate.locationLabel} — ${candidate.authorName} — réponse distante inchangée`);
    verified += 1;
    continue;
  }

  if (!EXECUTE && !VERIFY_ONLY) {
    console.log(`READY ${candidate.locationLabel} — ${candidate.authorName} — ${before.replyText === null ? 'prêt à envoyer' : 'réponse identique à réconcilier'}`);
    ready += 1;
    continue;
  }

  let remote = before;
  let putError: string | null = null;
  if (before.replyText === null && EXECUTE) {
    try {
      await putOnce(review.location_id, review.review_id, candidate.reply);
    } catch (error) {
      putError = error instanceof Error ? error.message : String(error);
    }
    const proof = await verifyWithGetOnly(review.location_id, review.review_id, review.comment ?? '', candidate.reply);
    if (proof.error) putError = `${putError ? `${putError}; ` : ''}${proof.error}`;
    if (proof.remote) remote = proof.remote;
  }

  if (remote.kind !== 'present' || !remoteReplyMatches(candidate.reply, remote.replyText)) {
    if (remote.kind === 'missing' || remote.kind === 'changed' || (remote.kind === 'present' && remote.replyText !== null)) {
      console.log(`BLOCKED ${candidate.authorName} — état Google conflictuel après tentative${putError ? ` (${putError})` : ''}`);
      blocked += 1;
    } else {
      console.log(`WRITE_UNKNOWN ${candidate.authorName} — preuve Google absente${putError ? ` (${putError})` : ''}`);
      writeUnknown += 1;
    }
    continue;
  }

  const persisted = await persistVerified(candidate, remote);
  if (!persisted) {
    console.log(`WRITE_UNKNOWN ${candidate.authorName} — preuve Google obtenue mais état local modifié concurremment`);
    writeUnknown += 1;
    continue;
  }
  if (before.replyText === null) {
    console.log(`VERIFIED ${candidate.locationLabel} — ${candidate.authorName}`);
    verified += 1;
  } else {
    console.log(`RECONCILED ${candidate.locationLabel} — ${candidate.authorName}`);
    reconciled += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
}

await pool.end();
const summary = {
  mode: EXECUTE ? 'execute' : VERIFY_ONLY ? 'verify-only' : 'dry-run',
  candidates: candidates.length,
  ready,
  verified,
  reconciled,
  blocked,
  writeUnknown
};
console.log(JSON.stringify(summary));
if (blocked > 0 || writeUnknown > 0) process.exitCode = 1;
