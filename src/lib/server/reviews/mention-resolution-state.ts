/**
 * GMB-010 — résolution des mentions envoyées par l'agent, et édition du roster par l'API.
 *
 * ⚠️ LE POINT DU MODULE : l'agent JUGE, le hub DÉCIDE, l'humain TRANCHE le doute.
 *
 * L'agent (Hermes) lit l'avis, rattache chaque prénom à un membre du roster et le dit
 * (`employeeId`, `matchKind`). Le hub ne lui fait pas confiance pour autant : une mention
 * n'est validée d'office que si son token tombe EXACTEMENT (casse/accents/ponctuation près)
 * sur un nom ou un alias d'un membre actif du salon, et que l'agent ne la rattache pas à
 * quelqu'un d'autre. Tout le reste — variante d'orthographe, mauvais salon, homonymes,
 * inconnu — reste `candidate` avec la suggestion de l'agent, et attend une décision humaine.
 *
 * Ce n'est pas de la prudence gratuite : le roster sert au calcul des primes. Une variante
 * devient un alias parce qu'un humain l'a validée (`rememberAlias`), jamais parce qu'un
 * modèle l'a supposée. Une fois retenue, elle passe en exact et ne revient plus.
 */
import {
	normalizeRosterToken,
	type EmployeeMentionsRoster,
	type EmployeeMentionsRosterEntry,
	type MentionExtractionOwner
} from './employee-mentions-state.js';

export type MentionSentiment = 'positive' | 'neutral' | 'negative';

/** Ce que l'agent affirme de son propre rattachement. Information, jamais autorité. */
export const AGENT_MATCH_KINDS = ['exact', 'alias', 'variant', 'unknown', 'ambiguous'] as const;
export type AgentMatchKind = (typeof AGENT_MATCH_KINDS)[number];

export type PendingMentionReason =
	| 'unknown_token'
	| 'wrong_location'
	| 'inactive'
	| 'ambiguous'
	| 'suggestion_conflict'
	| 'roster_unavailable';

export type MentionAssessment =
	| { status: 'validated'; employeeId: string; displayName: string }
	| { status: 'resolved'; reason: 'not_tracked'; employeeId: string; displayName: string }
	| { status: 'candidate'; reason: PendingMentionReason; suggestedEmployeeId: string | null };

function tokensOf(employee: EmployeeMentionsRosterEntry): string[] {
	return [employee.displayName, ...employee.aliases].map(normalizeRosterToken).filter(Boolean);
}

/**
 * Juge UNE mention contre le roster courant. Pure : la même entrée rend la même sortie,
 * donc une candidate peut être re-jugée à chaque nouvelle version du roster.
 */
export function assessSubmittedMention(input: {
	token: string;
	locationId: string;
	roster: EmployeeMentionsRoster | null;
	suggestedEmployeeId?: string | null;
}): MentionAssessment {
	const roster = input.roster;
	const known = (id: string | null | undefined) =>
		id && roster?.employees.some((employee) => employee.id === id) ? id : null;
	const suggestion = known(input.suggestedEmployeeId);
	if (!roster?.enabled) return { status: 'candidate', reason: 'roster_unavailable', suggestedEmployeeId: null };

	const normalized = normalizeRosterToken(input.token);
	if (!normalized) return { status: 'candidate', reason: 'unknown_token', suggestedEmployeeId: suggestion };

	const matching = roster.employees.filter((employee) => tokensOf(employee).includes(normalized));
	const active = matching.filter((employee) => employee.active);

	// Un non-suivi n'est jamais attribué : il se reconnaît dans tous les salons.
	const notTracked = active.find((employee) => employee.trackMentions === false);
	if (notTracked && (!suggestion || suggestion === notTracked.id)) {
		return { status: 'resolved', reason: 'not_tracked', employeeId: notTracked.id, displayName: notTracked.displayName };
	}

	const here = active.filter(
		(employee) => employee.trackMentions !== false && employee.locations.includes(input.locationId)
	);
	if (here.length > 1) {
		return { status: 'candidate', reason: 'ambiguous', suggestedEmployeeId: suggestion };
	}
	if (here.length === 1) {
		const employee = here[0];
		if (suggestion && suggestion !== employee.id) {
			return { status: 'candidate', reason: 'suggestion_conflict', suggestedEmployeeId: suggestion };
		}
		return { status: 'validated', employeeId: employee.id, displayName: employee.displayName };
	}

	const elsewhere = active.filter((employee) => employee.trackMentions !== false);
	if (elsewhere.length > 0) {
		return {
			status: 'candidate',
			reason: 'wrong_location',
			suggestedEmployeeId: suggestion ?? (elsewhere.length === 1 ? elsewhere[0].id : null)
		};
	}
	if (matching.length > 0) {
		return { status: 'candidate', reason: 'inactive', suggestedEmployeeId: suggestion ?? matching[0].id };
	}
	return { status: 'candidate', reason: 'unknown_token', suggestedEmployeeId: suggestion };
}

/**
 * Ajoute une mention validée à `gmb_reviews.mentioned_employees` sans rien écraser :
 * union par nom canonique, le premier sentiment posé reste. Rend `null` si rien ne change.
 */
export function mergeValidatedMention(
	existing: string | null,
	mention: { name: string; sentiment: MentionSentiment }
): string | null {
	let current: Array<{ name: string; sentiment: string }> = [];
	if (existing) {
		try {
			const parsed = JSON.parse(existing);
			if (Array.isArray(parsed)) {
				current = parsed.filter(
					(item): item is { name: string; sentiment: string } =>
						!!item && typeof item.name === 'string' && typeof item.sentiment === 'string'
				);
			}
		} catch {
			current = [];
		}
	}
	if (current.some((item) => item.name === mention.name)) return null;
	return JSON.stringify([...current, { name: mention.name, sentiment: mention.sentiment }]);
}

// ── Édition du roster ──────────────────────────────────────────────────────────

export type RosterChange =
	| { op: 'add_alias'; employeeId: string; alias: string }
	| { op: 'remove_alias'; employeeId: string; alias: string }
	| {
			op: 'add_employee';
			employeeId: string;
			displayName: string;
			locations: string[];
			aliases?: string[];
			publicReplyAllowed?: boolean;
			trackMentions?: boolean;
	  }
	| { op: 'deactivate'; employeeId: string }
	| { op: 'reactivate'; employeeId: string }
	| { op: 'set_locations'; employeeId: string; locations: string[] }
	| { op: 'set_public_reply'; employeeId: string; allowed: boolean }
	| { op: 'set_track_mentions'; employeeId: string; tracked: boolean }
	| { op: 'set_extraction'; owner: MentionExtractionOwner };

export type RosterChangeError =
	| 'invalid_changes'
	| 'invalid_change'
	| 'employee_not_found'
	| 'employee_exists'
	| 'alias_not_found'
	| 'unknown_location'
	| 'token_conflict';

const EMPLOYEE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CHANGES = 20;

function isName(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && normalizeRosterToken(value) !== '';
}

function isLocationList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** Valide la FORME des changements. Le sens (employé existant, salon connu…) vient après. */
export function parseRosterChanges(
	input: unknown
): { ok: true; changes: RosterChange[] } | { ok: false; code: RosterChangeError; index?: number } {
	if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CHANGES) return { ok: false, code: 'invalid_changes' };
	const changes: RosterChange[] = [];
	for (const [index, raw] of input.entries()) {
		const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
		const invalid = { ok: false as const, code: 'invalid_change' as const, index };
		if (!value) return invalid;
		if (value.op === 'set_extraction') {
			if (value.owner !== 'hub' && value.owner !== 'agent') return invalid;
			changes.push({ op: 'set_extraction', owner: value.owner });
			continue;
		}
		if (typeof value.employeeId !== 'string' || !EMPLOYEE_ID.test(value.employeeId)) return invalid;
		const employeeId = value.employeeId;
		switch (value.op) {
			case 'add_alias':
			case 'remove_alias':
				if (!isName(value.alias)) return invalid;
				changes.push({ op: value.op, employeeId, alias: value.alias.trim() });
				break;
			case 'add_employee':
				if (!isName(value.displayName) || !isLocationList(value.locations)) return invalid;
				if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.length > 20 || !value.aliases.every(isName))) return invalid;
				if (value.publicReplyAllowed !== undefined && typeof value.publicReplyAllowed !== 'boolean') return invalid;
				if (value.trackMentions !== undefined && typeof value.trackMentions !== 'boolean') return invalid;
				changes.push({
					op: 'add_employee',
					employeeId,
					displayName: value.displayName.trim(),
					locations: value.locations,
					aliases: (value.aliases as string[] | undefined)?.map((alias) => alias.trim()),
					publicReplyAllowed: value.publicReplyAllowed as boolean | undefined,
					trackMentions: value.trackMentions as boolean | undefined
				});
				break;
			case 'deactivate':
			case 'reactivate':
				changes.push({ op: value.op, employeeId });
				break;
			case 'set_locations':
				if (!isLocationList(value.locations)) return invalid;
				changes.push({ op: 'set_locations', employeeId, locations: value.locations });
				break;
			case 'set_public_reply':
				if (typeof value.allowed !== 'boolean') return invalid;
				changes.push({ op: 'set_public_reply', employeeId, allowed: value.allowed });
				break;
			case 'set_track_mentions':
				if (typeof value.tracked !== 'boolean') return invalid;
				changes.push({ op: 'set_track_mentions', employeeId, tracked: value.tracked });
				break;
			default:
				return invalid;
		}
	}
	return { ok: true, changes };
}

/**
 * Paires (salon, token) revendiquées par deux membres actifs suivis. C'est exactement ce
 * qui rendrait une mention indécidable — donc ce qu'un changement n'a pas le droit de créer.
 */
function tokenConflicts(employees: EmployeeMentionsRosterEntry[]): Set<string> {
	const owners = new Map<string, string>();
	const conflicts = new Set<string>();
	for (const employee of employees) {
		if (!employee.active || employee.trackMentions === false) continue;
		for (const location of employee.locations) {
			for (const token of new Set(tokensOf(employee))) {
				const key = `${location}\u0000${token}`;
				const owner = owners.get(key);
				if (owner && owner !== employee.id) conflicts.add(key);
				else owners.set(key, employee.id);
			}
		}
	}
	return conflicts;
}

/**
 * Applique des changements à une COPIE du roster. Tout ou rien : un seul changement
 * invalide refuse le lot, pour qu'une demande « retire X et ajoute Y » ne s'applique
 * jamais à moitié.
 */
export function applyRosterChanges(input: {
	roster: EmployeeMentionsRoster;
	changes: RosterChange[];
	knownLocations: string[];
}):
	| { ok: true; roster: EmployeeMentionsRoster; changed: boolean }
	| { ok: false; code: RosterChangeError; index: number } {
	const next: EmployeeMentionsRoster = structuredClone(input.roster);
	const before = JSON.stringify(next);
	const knownLocations = new Set(input.knownLocations);
	const conflictsBefore = tokenConflicts(next.employees);

	for (const [index, change] of input.changes.entries()) {
		if (change.op === 'set_extraction') {
			next.extraction = change.owner;
			continue;
		}
		const employee = next.employees.find((entry) => entry.id === change.employeeId);
		if (change.op === 'add_employee') {
			if (employee) return { ok: false, code: 'employee_exists', index };
			if (!change.locations.every((location) => knownLocations.has(location))) return { ok: false, code: 'unknown_location', index };
			next.employees.push({
				id: change.employeeId,
				displayName: change.displayName,
				aliases: [...new Set(change.aliases ?? [])],
				locations: [...new Set(change.locations)],
				active: true,
				eligibleForBonus: false,
				publicReplyAllowed: change.publicReplyAllowed ?? true,
				...(change.trackMentions === false ? { trackMentions: false } : {})
			});
			continue;
		}
		if (!employee) return { ok: false, code: 'employee_not_found', index };
		switch (change.op) {
			case 'add_alias': {
				const token = normalizeRosterToken(change.alias);
				if (!tokensOf(employee).includes(token)) employee.aliases.push(change.alias);
				break;
			}
			case 'remove_alias': {
				const token = normalizeRosterToken(change.alias);
				const kept = employee.aliases.filter((alias) => normalizeRosterToken(alias) !== token);
				if (kept.length === employee.aliases.length) return { ok: false, code: 'alias_not_found', index };
				employee.aliases = kept;
				break;
			}
			case 'deactivate':
				employee.active = false;
				break;
			case 'reactivate':
				employee.active = true;
				break;
			case 'set_locations':
				if (!change.locations.every((location) => knownLocations.has(location))) return { ok: false, code: 'unknown_location', index };
				employee.locations = [...new Set(change.locations)];
				break;
			case 'set_public_reply':
				employee.publicReplyAllowed = change.allowed;
				break;
			case 'set_track_mentions':
				if (change.tracked) delete employee.trackMentions;
				else employee.trackMentions = false;
				break;
		}
	}

	const conflictsAfter = tokenConflicts(next.employees);
	for (const key of conflictsAfter) {
		if (!conflictsBefore.has(key)) return { ok: false, code: 'token_conflict', index: input.changes.length - 1 };
	}
	return { ok: true, roster: next, changed: JSON.stringify(next) !== before };
}

/** `2026-10-01.1`, puis `.2` le même jour. La date est locale au salon (Europe/Zurich). */
export function nextRosterVersion(current: string, now: Date = new Date()): string {
	const today = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Europe/Zurich',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(now);
	const match = new RegExp(`^${today}\\.(\\d+)$`).exec(current);
	return `${today}.${match ? Number(match[1]) + 1 : 1}`;
}
