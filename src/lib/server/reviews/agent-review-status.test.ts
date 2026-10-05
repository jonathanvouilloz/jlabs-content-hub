import { describe, expect, it } from 'vitest';
import type { AppDb } from '../db/types.js';
import { gmbReviews, projectGmbLocations, reviewAutomationPolicies, reviewReplyProposals } from '../db/schema.js';
import { buildAgentReviewStatus } from './agent-review-service.js';

type Row = Record<string, unknown>;

/**
 * Base en mémoire juste assez pour `buildAgentReviewStatus` : les `where` sont ignorés (un
 * seul projet), toute tentative d'écriture est enregistrée — la vue doit n'en faire aucune.
 */
function fakeDb(tables: Map<unknown, Row[]>) {
	const writes: string[] = [];
	const chain = (rows: Row[]) => {
		const query = {
			where: () => query,
			orderBy: () => query,
			limit: () => query,
			then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) =>
				Promise.resolve(rows).then(resolve, reject)
		};
		return query;
	};
	const db = {
		select: () => ({ from: (table: unknown) => chain(tables.get(table) ?? []) }),
		insert: () => { writes.push('insert'); throw new Error('write'); },
		update: () => { writes.push('update'); throw new Error('write'); },
		delete: () => { writes.push('delete'); throw new Error('write'); },
		query: {
			projects: { findFirst: async () => ({ id: 'p-bc', slug: 'barberconcept', name: 'Barber Concept', archived: false }) },
			projectProjections: { findFirst: async () => undefined }
		}
	};
	return { db: db as unknown as AppDb, writes };
}

describe('buildAgentReviewStatus', () => {
	it('compte à partir des lignes canoniques sans aucune écriture', async () => {
		const now = new Date('2026-10-05T10:00:00Z');
		const { db, writes } = fakeDb(new Map<unknown, Row[]>([
			[gmbReviews, [
				{ reviewId: 'r1', locationId: 'loc-sion', locationLabel: 'Sion', rating: 5, comment: 'Top', createTime: '2026-10-05T08:00:00Z', remoteReplyText: null, lastSeenAt: '2026-10-05 06:00:00' },
				{ reviewId: 'r2', locationId: 'loc-sion', locationLabel: 'Sion', rating: 2, comment: 'Bof', createTime: '2026-10-04T12:00:00Z', remoteReplyText: null, lastSeenAt: '2026-10-05 06:00:00' },
				{ reviewId: 'r3', locationId: 'loc-sion', locationLabel: 'Sion', rating: 5, comment: 'Super', createTime: '2026-10-03T12:00:00Z', remoteReplyText: null, lastSeenAt: '2026-10-05 06:00:00' }
			]],
			[projectGmbLocations, [
				{ gmbLocationId: 'loc-sion', label: 'Sion', lastSyncAt: '2026-10-05 05:00:00', lastSyncStatus: 'success' }
			]],
			[reviewReplyProposals, [{ reviewId: 'r3', locationId: 'loc-sion', state: 'write_unknown' }]],
			[reviewAutomationPolicies, [{ scopeKey: '*', mode: 'guarded_auto', killSwitch: false, autoGenerationEnabled: true, minRatingForAutoSend: 4, escalationCategoriesJson: null }]]
		]));
		const data = await buildAgentReviewStatus({ db, projectSlug: 'barberconcept', now });
		expect(writes).toEqual([]);
		expect(data.periods.last7Days).toMatchObject({
			reviews: 3,
			requiresHuman: 1,
			writeUnknown: 1,
			pendingConfirmations: 1,
			// Sans projection courante, la porte `applyProjectionGate` bloque l'éligible : même verdict que GET /reviews.
			sensitiveOrBlocked: 1,
			eligibleAuto: 0
		});
		expect(data.pendingConfirmationsTotal).toBe(1);
		expect(data.freshness.overallStatus).toBe('healthy');
		expect(data.policy).toMatchObject({ status: 'active', minimumAutoRating: 4 });
		expect(JSON.stringify(data)).not.toMatch(/r1|r2|r3|Top|Bof|Super/);
	});
});
