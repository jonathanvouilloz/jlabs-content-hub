import { describe, expect, it } from 'vitest';
import { matchRosterMentions, parseEmployeeMentionsCapability, type EmployeeMentionsRoster } from './employee-mentions-state.js';
import {
	applyRosterChanges,
	assessSubmittedMention,
	mergeValidatedMention,
	nextRosterVersion,
	parseRosterChanges
} from './mention-resolution-state.js';

const LAUSANNE = 'locations/lausanne';
const JONCTION = 'locations/jonction';
const RIVE = 'locations/rive';

function employee(id: string, displayName: string, locations: string[], extra: Record<string, unknown> = {}) {
	return { id, displayName, aliases: [] as string[], locations, active: true, eligibleForBonus: false, publicReplyAllowed: true, ...extra };
}

const roster: EmployeeMentionsRoster = {
	enabled: true,
	version: '2026-09-02.1',
	employees: [
		employee('giuseppe', 'Giuseppe', [LAUSANNE]),
		employee('moha', 'Moha', [LAUSANNE]),
		employee('mohammed', 'Mohammed', [JONCTION]),
		employee('oums', 'Oums', [RIVE], { aliases: ['Oumss'] }),
		employee('henok-josief', 'Henok Josief', [RIVE], { trackMentions: false }),
		employee('kavind', 'Kavind', [LAUSANNE], { active: false })
	]
};

describe('assessSubmittedMention', () => {
	it('valide d office le nom exact du salon, casse et accents compris', () => {
		expect(assessSubmittedMention({ token: 'giuseppe', locationId: LAUSANNE, roster })).toEqual({
			status: 'validated', employeeId: 'giuseppe', displayName: 'Giuseppe'
		});
		expect(assessSubmittedMention({ token: 'OUMSS', locationId: RIVE, roster })).toMatchObject({ status: 'validated', employeeId: 'oums' });
	});

	it('⭐ une variante d orthographe reste en attente avec la suggestion de l agent', () => {
		expect(assessSubmittedMention({ token: 'Guiseppe', locationId: LAUSANNE, roster, suggestedEmployeeId: 'giuseppe' })).toEqual({
			status: 'candidate', reason: 'unknown_token', suggestedEmployeeId: 'giuseppe'
		});
	});

	it('un exact que l agent rattache à quelqu un d autre est un doute, pas une validation', () => {
		expect(assessSubmittedMention({ token: 'Moha', locationId: LAUSANNE, roster, suggestedEmployeeId: 'mohammed' })).toMatchObject({
			status: 'candidate', reason: 'suggestion_conflict', suggestedEmployeeId: 'mohammed'
		});
	});

	it('un prénom du roster cité dans un autre salon n est pas attribué', () => {
		expect(assessSubmittedMention({ token: 'Mohammed', locationId: LAUSANNE, roster })).toEqual({
			status: 'candidate', reason: 'wrong_location', suggestedEmployeeId: 'mohammed'
		});
	});

	it('un inactif et un inconnu restent en attente', () => {
		expect(assessSubmittedMention({ token: 'Kavind', locationId: LAUSANNE, roster })).toMatchObject({ status: 'candidate', reason: 'inactive' });
		expect(assessSubmittedMention({ token: 'Joseph', locationId: LAUSANNE, roster })).toMatchObject({ status: 'candidate', reason: 'unknown_token', suggestedEmployeeId: null });
	});

	it('une suggestion hors roster est ignorée', () => {
		expect(assessSubmittedMention({ token: 'Joseph', locationId: LAUSANNE, roster, suggestedEmployeeId: 'fantome' })).toMatchObject({ suggestedEmployeeId: null });
	});

	it('un non-suivi est reconnu dans tous les salons et jamais attribué', () => {
		expect(assessSubmittedMention({ token: 'henok josief', locationId: LAUSANNE, roster })).toEqual({
			status: 'resolved', reason: 'not_tracked', employeeId: 'henok-josief', displayName: 'Henok Josief'
		});
		const matched = matchRosterMentions({ candidates: [{ name: 'Henok Josief', sentiment: 'positive' }], locationId: LAUSANNE, roster });
		expect(matched).toEqual({ mentions: [], unknownTokens: [] });
	});

	it('sans roster, tout reste en attente', () => {
		expect(assessSubmittedMention({ token: 'Moha', locationId: LAUSANNE, roster: null })).toMatchObject({ status: 'candidate', reason: 'roster_unavailable' });
	});
});

describe('mergeValidatedMention', () => {
	it('ajoute sans écraser et ne double jamais un nom', () => {
		expect(mergeValidatedMention(null, { name: 'Moha', sentiment: 'positive' })).toBe('[{"name":"Moha","sentiment":"positive"}]');
		const existing = '[{"name":"Moha","sentiment":"neutral"}]';
		expect(mergeValidatedMention(existing, { name: 'Moha', sentiment: 'positive' })).toBeNull();
		expect(JSON.parse(mergeValidatedMention(existing, { name: 'Giuseppe', sentiment: 'positive' })!)).toHaveLength(2);
	});
});

describe('changements de roster', () => {
	const known = [LAUSANNE, JONCTION, RIVE];

	it('retenir une variante la fait passer en exact', () => {
		const parsed = parseRosterChanges([{ op: 'add_alias', employeeId: 'giuseppe', alias: 'Guiseppe' }]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const applied = applyRosterChanges({ roster, changes: parsed.changes, knownLocations: known });
		expect(applied).toMatchObject({ ok: true, changed: true });
		if (!applied.ok) return;
		expect(assessSubmittedMention({ token: 'guiseppe', locationId: LAUSANNE, roster: applied.roster })).toMatchObject({ status: 'validated', employeeId: 'giuseppe' });
		expect(roster.employees[0].aliases).toEqual([]);
	});

	it('désactiver retire des matches ; un alias déjà connu ne change rien', () => {
		const off = applyRosterChanges({ roster, changes: [{ op: 'deactivate', employeeId: 'mohammed' }], knownLocations: known });
		expect(off.ok && assessSubmittedMention({ token: 'Mohammed', locationId: JONCTION, roster: off.roster }).status).toBe('candidate');
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_alias', employeeId: 'oums', alias: 'oumss' }], knownLocations: known })).toMatchObject({ ok: true, changed: false });
	});

	it('⭐ refuse un alias qui rendrait deux personnes indiscernables dans un salon', () => {
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_alias', employeeId: 'moha', alias: 'Giuseppe' }], knownLocations: known })).toMatchObject({ ok: false, code: 'token_conflict' });
		// Même token dans deux salons différents : pas de conflit.
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_alias', employeeId: 'mohammed', alias: 'Moha' }], knownLocations: known })).toMatchObject({ ok: true });
	});

	it('tout ou rien, salons et employés vérifiés', () => {
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_alias', employeeId: 'giuseppe', alias: 'Gueppe' }, { op: 'deactivate', employeeId: 'inconnu' }], knownLocations: known })).toMatchObject({ ok: false, code: 'employee_not_found', index: 1 });
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_employee', employeeId: 'n2', displayName: 'N2', locations: ['locations/ailleurs'] }], knownLocations: known })).toMatchObject({ ok: false, code: 'unknown_location' });
		expect(applyRosterChanges({ roster, changes: [{ op: 'add_employee', employeeId: 'moha', displayName: 'Moha', locations: [LAUSANNE] }], knownLocations: known })).toMatchObject({ ok: false, code: 'employee_exists' });
	});

	it('un nouvel employé n est jamais éligible à une prime par l API, et le roster reste valide', () => {
		const applied = applyRosterChanges({
			roster,
			changes: [{ op: 'add_employee', employeeId: 'n2', displayName: 'N2', locations: [LAUSANNE] }, { op: 'set_extraction', owner: 'agent' }],
			knownLocations: known
		});
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.roster.employees.at(-1)).toMatchObject({ id: 'n2', eligibleForBonus: false, active: true });
		expect(applied.roster.extraction).toBe('agent');
		expect(parseEmployeeMentionsCapability({ gmb: { employeeMentions: applied.roster } }).enabled).toBe(true);
	});

	it('rejette les formes invalides', () => {
		expect(parseRosterChanges([])).toMatchObject({ ok: false, code: 'invalid_changes' });
		expect(parseRosterChanges([{ op: 'add_alias', employeeId: 'Giuseppe!', alias: 'x' }])).toMatchObject({ ok: false, index: 0 });
		expect(parseRosterChanges([{ op: 'set_extraction', owner: 'robot' }])).toMatchObject({ ok: false });
		expect(parseRosterChanges([{ op: 'drop_table', employeeId: 'moha' }])).toMatchObject({ ok: false });
	});

	it('versionne par jour local', () => {
		const now = new Date('2026-10-01T10:00:00Z');
		expect(nextRosterVersion('2026-09-02.1', now)).toBe('2026-10-01.1');
		expect(nextRosterVersion('2026-10-01.3', now)).toBe('2026-10-01.4');
	});
});
