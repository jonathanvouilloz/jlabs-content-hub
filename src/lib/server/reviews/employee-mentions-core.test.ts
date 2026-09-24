import { describe, expect, it } from 'vitest';
import { extractBoundedEmployeeMentions } from './employee-mentions-core.js';

describe('extractBoundedEmployeeMentions', () => {
	it('attend chaque extraction, borne le lot et s’arrête après une annulation', async () => {
		const controller = new AbortController();
		const seen: string[] = [];
		const result = await extractBoundedEmployeeMentions({
			reviews: [
				{ reviewId: 'r1', locationId: 'loc', comment: 'Raphaël était parfait' },
				{ reviewId: 'r2', locationId: 'loc', comment: 'Merci Raphaël' },
				{ reviewId: 'r3', locationId: 'loc', comment: 'hors plafond' }
			],
			maxReviews: 2,
			signal: controller.signal,
			extract: async (review) => {
				seen.push(review.reviewId);
				if (review.reviewId === 'r1') controller.abort();
				return [{ name: 'Raphaël', sentiment: 'positive' }];
			}
		});

		expect(seen).toEqual(['r1']);
		expect(result).toEqual({ processed: 1, capped: 1, aborted: true, results: [{ reviewId: 'r1', locationId: 'loc', candidates: [{ name: 'Raphaël', sentiment: 'positive' }] }] });
	});
});
