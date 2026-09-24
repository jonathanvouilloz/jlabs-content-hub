import { describe, expect, it } from 'vitest';
import {
	matchRosterMentions,
	normalizeRosterToken,
	parseEmployeeMentionsCapability,
	type EmployeeMentionsRoster
} from './employee-mentions-state.js';

const roster: EmployeeMentionsRoster = {
	enabled: true,
	version: 'barberconcept-2026-08-16',
	employees: [
		{
			id: 'raphael',
			displayName: 'Raphaël',
			aliases: ['Rapahael'],
			locations: ['barber-lausanne'],
			active: true,
			eligibleForBonus: true,
			publicReplyAllowed: true
		}
	]
};

describe('employee mentions roster state', () => {
	it('defaults to disabled when the projection capability is absent or malformed', () => {
		expect(parseEmployeeMentionsCapability({})).toEqual({ enabled: false, roster: null });
		expect(parseEmployeeMentionsCapability({ gmb: { employeeMentions: { enabled: 'yes' } } })).toEqual({
			enabled: false,
			roster: null
		});
	});

	it('accepts a versioned roster only when the capability is explicitly enabled', () => {
		expect(
			parseEmployeeMentionsCapability({ gmb: { employeeMentions: roster } })
		).toEqual({ enabled: true, roster });
	});

	it('normalizes accents and case before matching names', () => {
		expect(normalizeRosterToken('  RAPHAËL ')).toBe('raphael');
	});

	it('maps a validated alias to its canonical employee without inventing an unknown name', () => {
		const result = matchRosterMentions({
			candidates: [
				{ name: 'Rapahael', sentiment: 'positive' },
				{ name: 'Inconnu', sentiment: 'positive' }
			],
			locationId: 'barber-lausanne',
			roster
		});

		expect(result.mentions).toEqual([{ name: 'Raphaël', sentiment: 'positive' }]);
		expect(result.unknownTokens).toEqual(['Inconnu']);
	});
});
