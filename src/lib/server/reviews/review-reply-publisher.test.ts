import { describe, expect, it, vi } from 'vitest';
import { publishReviewReply, runIdempotentReviewPublication } from './review-reply-publisher.js';
import { buildReviewSnapshotHash } from './review-reply-candidate-state.js';

const proposal = { id: 'proposal-1', reviewId: 'r-1', replyText: 'Merci pour votre retour !' };

describe('publishReviewReply', () => {
	it('lit Google avant et apres le PUT, puis confirme un texte identique', async () => {
		const loadRemote = vi.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: proposal.replyText });
		const putReply = vi.fn().mockResolvedValue(undefined);
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({ proposal, loadRemote, putReply, record })).resolves.toEqual({ state: 'verified' });
		expect(putReply).toHaveBeenCalledExactlyOnceWith(proposal.replyText);
		expect(loadRemote).toHaveBeenCalledTimes(2);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'sent', 'verified']);
	});

	it('relit Google plusieurs fois apres un PUT accepte avant de conclure (latence de propagation)', async () => {
		const loadRemote = vi.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({
				kind: 'present',
				replyText: `${proposal.replyText}

(Translated by Google)
Thanks for your feedback!`
			});
		const putReply = vi.fn().mockResolvedValue({ replyAt: '2026-09-28 10:39:38' });
		const record = vi.fn().mockResolvedValue(undefined);
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({
			proposal, loadRemote, putReply, record, sleep, verifyDelaysMs: [0, 2000, 4000]
		})).resolves.toEqual({ state: 'verified' });
		expect(putReply).toHaveBeenCalledTimes(1);
		expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000]);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'sent', 'verified']);
		expect(record.mock.calls[1]?.[0]).toMatchObject({ putReplyAt: '2026-09-28 10:39:38' });
	});

	it('conclut write_unknown sans second PUT si la reponse reste invisible apres toutes les relectures', async () => {
		const loadRemote = vi.fn().mockResolvedValue({ kind: 'present', replyText: null });
		const putReply = vi.fn().mockResolvedValue({ replyAt: null });
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({
			proposal, loadRemote, putReply, record, sleep: vi.fn().mockResolvedValue(undefined), verifyDelaysMs: [0, 1, 1]
		})).resolves.toMatchObject({ state: 'write_unknown' });
		expect(putReply).toHaveBeenCalledTimes(1);
		expect(loadRemote).toHaveBeenCalledTimes(4);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual(['reserved', 'sent', 'write_unknown']);
	});

	it('ne rejoue jamais un PUT qui a timeout', async () => {
		const loadRemote = vi.fn()
			.mockResolvedValueOnce({ kind: 'present', replyText: null })
			.mockResolvedValueOnce({ kind: 'present', replyText: null });
		const putReply = vi.fn().mockRejectedValue(new Error('request timed out'));
		const record = vi.fn().mockResolvedValue(undefined);

		await expect(publishReviewReply({ proposal, loadRemote, putReply, record, verifyDelaysMs: [0] })).resolves.toMatchObject({
			state: 'write_unknown'
		});
		expect(putReply).toHaveBeenCalledTimes(1);
		expect(record.mock.calls.map(([event]) => event.state)).toEqual([
			'reserved',
			'write_unknown',
			'write_unknown'
		]);
		// Le PUT est parti : /reconcile doit appliquer la fenêtre de propagation.
		expect(record.mock.calls[1]?.[0]).toMatchObject({ state: 'write_unknown', putAttempted: true });
	});

	it('ne remplace jamais une reponse distante existante', async () => {
		const putReply = vi.fn();
		await expect(publishReviewReply({
			proposal,
			loadRemote: vi.fn().mockResolvedValue({ kind: 'present', replyText: 'Reponse existante' }),
			putReply,
			record: vi.fn().mockResolvedValue(undefined)
		})).resolves.toEqual({ state: 'conflict', reason: 'remote_reply_differs' });
		expect(putReply).not.toHaveBeenCalled();
	});

	it('refuse le PUT si le snapshot Google a change depuis la proposition', async () => {
		const fullProposal = {
			...proposal,
			projectId: 'project-1',
			locationId: 'locations/rive',
			rating: 5,
			comment: 'Texte initial',
			remoteUpdateAt: '2026-09-24T08:00:00Z',
			reviewSnapshotHash: buildReviewSnapshotHash({
				projectId: 'project-1',
				reviewId: proposal.reviewId,
				locationId: 'locations/rive',
				rating: 5,
				comment: 'Texte initial',
				remoteUpdateAt: '2026-09-24T08:00:00Z'
			})
		};
		const putReply = vi.fn();
		await expect(publishReviewReply({
			proposal: fullProposal,
			loadRemote: vi.fn().mockResolvedValue({
				kind: 'present',
				replyText: null,
				rating: 4,
				comment: 'Texte modifie',
				updateAt: '2026-09-24T09:00:00Z'
			}),
			putReply,
			record: vi.fn().mockResolvedValue(undefined)
		})).resolves.toEqual({ state: 'conflict', reason: 'snapshot_changed' });
		expect(putReply).not.toHaveBeenCalled();
	});

	it('un double appel avec la meme reservation ne produit qu un PUT', async () => {
		let reserved = false;
		let saved: Awaited<ReturnType<typeof publishReviewReply>> = {
			state: 'write_unknown',
			error: 'not finished'
		};
		const putReply = vi.fn().mockResolvedValue(undefined);
		const execute = async () => {
			const result = await publishReviewReply({
				proposal,
				loadRemote: vi.fn()
					.mockResolvedValueOnce({ kind: 'present', replyText: null })
					.mockResolvedValueOnce({ kind: 'present', replyText: proposal.replyText }),
				putReply,
				record: vi.fn().mockResolvedValue(undefined)
			});
			saved = result;
			return result;
		};
		const run = () => runIdempotentReviewPublication({
			reserve: async () => {
				if (reserved) return { acquired: false, result: saved } as const;
				reserved = true;
				return { acquired: true } as const;
			},
			execute
		});

		await expect(run()).resolves.toMatchObject({ idempotent: false, result: { state: 'verified' } });
		await expect(run()).resolves.toMatchObject({ idempotent: true, result: { state: 'verified' } });
		expect(putReply).toHaveBeenCalledTimes(1);
	});
});
