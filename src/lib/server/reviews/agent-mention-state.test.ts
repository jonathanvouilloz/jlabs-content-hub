import { describe, expect, it } from 'vitest';
import { buildAgentMentionCandidate } from './agent-mention-state.js';

describe('buildAgentMentionCandidate', () => {
	it('reste une proposition a valider et ne devient jamais une prime', () => {
		const candidate = buildAgentMentionCandidate({
			token: ' Noe ',
			sentiment: 'positive',
			evidence: 'Merci Noe pour la coupe',
			confidence: 0.91,
			rosterVersion: 'roster-7'
		});
		expect(candidate).toMatchObject({
			detectedToken: 'Noe',
			normalizedToken: 'noe',
			status: 'candidate'
		});
		expect(candidate).not.toHaveProperty('bonus');
		expect(candidate).not.toHaveProperty('eligibleForBonus');
	});
});
