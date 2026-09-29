import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../db/types.js';
import {
	gmbReviews,
	reviewReplyDeliveries,
	reviewReplyDeliveryEvents,
	reviewReplyProposals
} from '../db/schema.js';
import { toDbTimestamp } from '../timestamps.js';
import { reconcileAgentReviewReply } from './agent-review-service.js';
import { publishReviewReply, runIdempotentReviewPublication, type ReviewReplyPublishResult } from './review-reply-publisher.js';
import type { RemoteReviewSnapshot } from './review-reply-publisher-state.js';

/**
 * Incident Hermes du 2026-09-29 (`de76afbef07f442e1b074a82`) : Google accepte le PUT mais
 * ne montre la réponse qu'après les relectures de publish. La suite exige :
 * publish → write_unknown, reconcile immédiat → encore write_unknown, reconcile ultérieur
 * → verified — avec UN seul PUT et des relectures GET seulement ensuite.
 */

const REPLY = 'Merci pour ta visite au salon !\n\nL\'équipe Barber Concept';

/** Faux Google : compte les PUT et les GET ; la réponse devient visible à la demande. */
function fakeGoogle() {
	let visible = false;
	const google = {
		puts: 0,
		gets: 0,
		makeVisible: () => {
			visible = true;
		},
		loadRemote: vi.fn(async (): Promise<RemoteReviewSnapshot> => {
			google.gets += 1;
			return { kind: 'present', replyText: visible ? REPLY : null, replyAt: visible ? '2026-09-29T07:45:10Z' : null };
		}),
		putReply: vi.fn(async () => {
			google.puts += 1;
			return { replyAt: null };
		})
	};
	return google;
}

type Row = Record<string, unknown>;

/**
 * Base en mémoire, juste assez pour `reconcileAgentReviewReply` : les `where` sont ignorés
 * (une seule proposition, une seule livraison), chaque écriture est comptée.
 */
function fakeDb(input: { proposalState: string; events: Row[] }) {
	const proposal: Row = {
		id: 'de76afbef07f442e1b074a82',
		projectId: 'project-bc',
		reviewId: 'review-lausanne',
		replyText: REPLY,
		state: input.proposalState
	};
	const delivery: Row = { id: 'delivery-1', proposalId: proposal.id, projectId: 'project-bc', state: input.proposalState };
	const review: Row = { reviewId: 'review-lausanne' };
	const writes: { table: string; values: Row }[] = [];
	const tableName = (table: unknown) =>
		table === reviewReplyProposals ? 'proposals'
			: table === reviewReplyDeliveries ? 'deliveries'
				: table === reviewReplyDeliveryEvents ? 'events'
					: table === gmbReviews ? 'reviews'
						: 'other';
	const target = (table: unknown) =>
		table === reviewReplyProposals ? proposal : table === reviewReplyDeliveries ? delivery : review;
	const db = {
		query: {
			projects: { findFirst: async () => ({ id: 'project-bc', slug: 'barberconcept', name: 'Barber Concept', archived: false }) },
			reviewReplyProposals: { findFirst: async () => ({ ...proposal }) },
			reviewReplyDeliveries: { findFirst: async () => ({ ...delivery }) },
			reviewReplyDeliveryEvents: { findMany: async () => input.events.map((event) => ({ ...event })) }
		},
		insert: (table: unknown) => ({
			values: async (values: Row) => {
				writes.push({ table: tableName(table), values });
				if (table === reviewReplyDeliveryEvents) input.events.push({ ...values, createdAt: toDbTimestamp() });
			}
		}),
		update: (table: unknown) => ({
			set: (values: Row) => ({
				where: async () => {
					writes.push({ table: tableName(table), values });
					Object.assign(target(table), Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)));
				}
			})
		})
	};
	return { db: db as unknown as AppDb, proposal, writes };
}

describe('publish → write_unknown → reconcile (GET-only) → verified', () => {
	it('conclut verified sans second PUT, reconcile n’écrivant qu’un événement d’audit à la conclusion', async () => {
		const google = fakeGoogle();
		const putAt = new Date('2026-09-29T07:45:00Z');
		const events: Row[] = [];

		// 1. publish : PUT accepté, mais la réponse reste invisible pendant toutes les relectures.
		const published = await publishReviewReply({
			proposal: { id: 'de76afbef07f442e1b074a82', reviewId: 'review-lausanne', replyText: REPLY },
			loadRemote: google.loadRemote,
			putReply: google.putReply,
			record: async (event) => {
				events.push({
					state: event.state,
					detailJson: JSON.stringify({ error: event.error, putAttempted: event.putAttempted || undefined }),
					createdAt: toDbTimestamp(putAt)
				});
			},
			sleep: async () => undefined
		});
		expect(published.state).toBe('write_unknown');
		expect(google.puts).toBe(1);
		const getsAfterPublish = google.gets;

		const { db, proposal, writes } = fakeDb({ proposalState: 'write_unknown', events });
		const reconcile = (now: Date) =>
			reconcileAgentReviewReply({
				db,
				projectSlug: 'barberconcept',
				proposalId: 'de76afbef07f442e1b074a82',
				loadRemote: google.loadRemote,
				now
			});

		// 2. reconcile immédiat : toujours invisible, dans la fenêtre de propagation.
		const early = await reconcile(new Date(putAt.getTime() + 10_000));
		expect(early).toEqual({
			state: 'write_unknown',
			reason: 'awaiting_remote_propagation',
			retryAfterSeconds: 890,
			idempotent: false
		});
		expect(writes).toEqual([]);

		// 3. reconcile ultérieur : Google montre enfin la réponse.
		google.makeVisible();
		const late = await reconcile(new Date(putAt.getTime() + 60_000));
		expect(late).toEqual({ state: 'verified', idempotent: false });
		expect(writes.filter((write) => write.table === 'events')).toHaveLength(1);
		expect(proposal.state).toBe('verified');

		// 4. reconcile répété : idempotent, aucune relecture Google, aucune écriture.
		const writesBefore = writes.length;
		const getsBefore = google.gets;
		expect(await reconcile(new Date(putAt.getTime() + 120_000))).toEqual({ state: 'verified', idempotent: true });
		expect(writes).toHaveLength(writesBefore);
		expect(google.gets).toBe(getsBefore);

		expect(google.puts).toBe(1);
		expect(google.putReply).toHaveBeenCalledTimes(1);
		expect(google.gets).toBe(getsAfterPublish + 2);
	});

	it('un PUT parti en timeout ne rend pas `retry_eligible` pendant la fenêtre de propagation', async () => {
		const google = fakeGoogle();
		const putAt = new Date('2026-09-29T07:45:00Z');
		const events: Row[] = [
			{ state: 'reserved', detailJson: '{}', createdAt: toDbTimestamp(putAt) },
			{ state: 'write_unknown', detailJson: '{"error":"timeout","putAttempted":true}', createdAt: toDbTimestamp(putAt) },
			{ state: 'write_unknown', detailJson: '{"error":"Google ne confirme toujours aucune réponse"}', createdAt: toDbTimestamp(putAt) }
		];
		const { db, writes } = fakeDb({ proposalState: 'write_unknown', events });

		const result = await reconcileAgentReviewReply({
			db,
			projectSlug: 'barberconcept',
			proposalId: 'de76afbef07f442e1b074a82',
			loadRemote: google.loadRemote,
			now: new Date(putAt.getTime() + 60_000)
		});
		expect(result).toMatchObject({ state: 'write_unknown', reason: 'awaiting_remote_propagation' });
		expect(writes).toEqual([]);
		expect(google.puts).toBe(0);
	});

	it('un publish répété avec la même clé d’idempotence ne déclenche jamais un second PUT', async () => {
		const google = fakeGoogle();
		let saved: ReviewReplyPublishResult | null = null;
		const run = () =>
			runIdempotentReviewPublication({
				reserve: async () => (saved ? { acquired: false, result: saved } as const : { acquired: true } as const),
				execute: async () => {
					saved = await publishReviewReply({
						proposal: { id: 'p', reviewId: 'r', replyText: REPLY },
						loadRemote: google.loadRemote,
						putReply: google.putReply,
						record: async () => undefined,
						sleep: async () => undefined
					});
					return saved;
				}
			});

		await expect(run()).resolves.toMatchObject({ idempotent: false, result: { state: 'write_unknown' } });
		await expect(run()).resolves.toMatchObject({ idempotent: true, result: { state: 'write_unknown' } });
		await expect(run()).resolves.toMatchObject({ idempotent: true, result: { state: 'write_unknown' } });
		expect(google.puts).toBe(1);
	});
});
