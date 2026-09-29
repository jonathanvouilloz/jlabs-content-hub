import { describe, expect, it } from 'vitest';
import {
	toPublicationResponse,
	toPublishResponse,
	type AgentPublicationOutcome
} from './agent-publication-response.js';

const outcomes: AgentPublicationOutcome[] = [
	{ state: 'verified' },
	{ state: 'conflict', reason: 'remote_reply_differs' },
	{ state: 'write_unknown', reason: 'awaiting_remote_propagation', retryAfterSeconds: 840 },
	{ state: 'write_unknown', error: 'Google ne confirme toujours aucune réponse après le PUT.' },
	{ state: 'retry_eligible' }
];

describe('contrat de réponse publish / reconcile', () => {
	it('porte le même champ `state`, à la même profondeur, pour tous les états et les deux endpoints', () => {
		for (const outcome of outcomes) {
			const reconcile = toPublicationResponse(outcome, { idempotent: false });
			const publish = toPublishResponse(outcome, { idempotent: false });
			expect(reconcile.state).toBe(outcome.state);
			expect(publish.state).toBe(outcome.state);
			const { result: _legacy, ...publishCanonical } = publish;
			expect(publishCanonical).toEqual(reconcile);
			expect(Object.keys(reconcile)).not.toContain('status');
			expect(Object.keys(reconcile)).not.toContain('resultStatus');
		}
	});

	it('garde `result` en alias déprécié de l’ancienne forme de publish', () => {
		expect(toPublishResponse({ state: 'write_unknown', error: 'timeout' }, { idempotent: true })).toEqual({
			state: 'write_unknown',
			error: 'timeout',
			idempotent: true,
			result: { state: 'write_unknown', error: 'timeout' }
		});
	});

	it('transporte reason et retryAfterSeconds sans inventer de champ vide', () => {
		expect(toPublicationResponse({ state: 'verified' }, { idempotent: true })).toEqual({
			state: 'verified',
			idempotent: true
		});
		expect(
			toPublicationResponse(
				{ state: 'write_unknown', reason: 'awaiting_remote_propagation', retryAfterSeconds: 0 },
				{ idempotent: false }
			)
		).toEqual({ state: 'write_unknown', reason: 'awaiting_remote_propagation', retryAfterSeconds: 0, idempotent: false });
	});
});
