import { describe, expect, it, vi } from 'vitest';
import { publishReviewReply } from './review-reply-publisher.js';

const proposal = { id: 'proposal-1', reviewId: 'reviews/r-1', replyText: 'Merci pour votre retour !' };

describe('publishReviewReply', () => {
	it('relit Google avant et après le PUT, puis ne confirme qu’un texte identique', async () => {
		const loadRemote = vi
			.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: proposal.replyText });
		const putReply = vi.fn().mockResolvedValue(undefined);
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({ proposal, loadRemote, putReply, record })).resolves.toEqual({
			state: 'verified'
		});
		expect(putReply).toHaveBeenCalledExactlyOnceWith(proposal.replyText);
		expect(loadRemote).toHaveBeenCalledTimes(2);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'sent', 'verified']);
	});

	it('ne rejoue pas un timeout : il relit Google et confirme l’écriture si elle est arrivée', async () => {
		const loadRemote = vi
			.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: proposal.replyText });
		const putReply = vi.fn().mockRejectedValue(new Error('request timed out'));
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({ proposal, loadRemote, putReply, record })).resolves.toEqual({
			state: 'verified'
		});
		expect(putReply).toHaveBeenCalledTimes(1);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'write_unknown', 'verified']);
	});

	it('journalise une divergence distante après PUT et s’arrête sans boucle', async () => {
		const loadRemote = vi
			.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: 'Une réponse écrite ailleurs.' });
		const putReply = vi.fn().mockResolvedValue(undefined);
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({ proposal, loadRemote, putReply, record })).resolves.toEqual({
			state: 'conflict',
			reason: 'remote_reply_differs'
		});
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'sent', 'conflict']);
	});
});
