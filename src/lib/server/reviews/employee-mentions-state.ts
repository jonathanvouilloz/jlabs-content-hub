export type Sentiment = 'positive' | 'neutral' | 'negative';
export interface Mention { name: string; sentiment: Sentiment }

export interface EmployeeMentionsRosterEntry {
	id: string;
	displayName: string;
	aliases: string[];
	locations: string[];
	active: boolean;
	eligibleForBonus: boolean;
	publicReplyAllowed: boolean;
	/**
	 * `false` = reconnu puis écarté (cofondateur, pas un barbier au compteur). Absent = suivi.
	 * Un non-suivi reste au roster, sinon chacune de ses citations lèverait une alerte.
	 */
	trackMentions?: boolean;
}

/**
 * Qui juge les noms cités : le détecteur LLM du hub (`hub`, défaut) ou l'agent qui
 * rédige les réponses (`agent`). Une seule source d'extraction par projet.
 */
export type MentionExtractionOwner = 'hub' | 'agent';

export interface EmployeeMentionsRoster {
	enabled: boolean;
	version: string;
	extraction?: MentionExtractionOwner;
	employees: EmployeeMentionsRosterEntry[];
}

export interface EmployeeMentionsCapability {
	enabled: boolean;
	roster: EmployeeMentionsRoster | null;
}

/**
 * Projection `gmb.employeeMentions`. L'absence ou une forme douteuse ne peut jamais
 * activer l'analyse : la capability est opt-in explicite projet par projet.
 */
export function parseEmployeeMentionsCapability(payload: unknown): EmployeeMentionsCapability {
	if (!payload || typeof payload !== 'object') return { enabled: false, roster: null };
	const candidate = (payload as { gmb?: { employeeMentions?: unknown } }).gmb?.employeeMentions;
	if (!candidate || typeof candidate !== 'object') return { enabled: false, roster: null };
	const roster = candidate as Partial<EmployeeMentionsRoster>;
	if (
		roster.enabled !== true ||
		typeof roster.version !== 'string' ||
		roster.version.trim() === '' ||
		(roster.extraction !== undefined && roster.extraction !== 'hub' && roster.extraction !== 'agent') ||
		!Array.isArray(roster.employees) ||
		!roster.employees.every(isValidRosterEntry)
	) {
		return { enabled: false, roster: null };
	}
	return { enabled: true, roster: roster as EmployeeMentionsRoster };
}

function isValidRosterEntry(value: unknown): value is EmployeeMentionsRosterEntry {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<EmployeeMentionsRosterEntry>;
	return (
		typeof entry.id === 'string' && entry.id.trim() !== '' &&
		typeof entry.displayName === 'string' && entry.displayName.trim() !== '' &&
		Array.isArray(entry.aliases) && entry.aliases.every((alias) => typeof alias === 'string') &&
		Array.isArray(entry.locations) && entry.locations.every((location) => typeof location === 'string') &&
		typeof entry.active === 'boolean' &&
		typeof entry.eligibleForBonus === 'boolean' &&
		typeof entry.publicReplyAllowed === 'boolean' &&
		(entry.trackMentions === undefined || typeof entry.trackMentions === 'boolean')
	);
}

export interface MentionCandidate {
	name: string;
	sentiment: Sentiment;
}

export interface RosterMatchResult {
	mentions: Mention[];
	unknownTokens: string[];
}

/** Accent/casse/espace n'appartiennent pas à l'identité d'un prénom. */
export function normalizeRosterToken(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLocaleLowerCase('fr')
		.replace(/[^\p{L}\p{N}]+/gu, '')
		.trim();
}

/**
 * N'attribue que des candidats explicites vers le roster versionné.
 * Les inconnus restent nommés afin que le détecteur puisse créer un finding ;
 * aucun rapprochement flou ne peut créer un employé ou une attribution erronée.
 */
export function matchRosterMentions(input: {
	candidates: MentionCandidate[];
	locationId: string;
	roster: EmployeeMentionsRoster;
}): RosterMatchResult {
	if (!input.roster.enabled) return { mentions: [], unknownTokens: [] };

	const byToken = new Map<string, EmployeeMentionsRosterEntry>();
	// Un non-suivi n'est jamais attribué : il peut donc être reconnu dans tous les salons.
	const notTracked = new Set<string>();
	for (const employee of input.roster.employees) {
		if (!employee.active) continue;
		const tokens = [employee.displayName, ...employee.aliases].map(normalizeRosterToken).filter(Boolean);
		if (employee.trackMentions === false) {
			for (const token of tokens) notTracked.add(token);
			continue;
		}
		if (!employee.locations.includes(input.locationId)) continue;
		for (const token of tokens) byToken.set(token, employee);
	}

	const mentions = new Map<string, Mention>();
	const unknownTokens = new Set<string>();
	for (const candidate of input.candidates) {
		const raw = candidate.name.trim();
		const normalized = normalizeRosterToken(raw);
		const employee = byToken.get(normalized);
		if (!employee) {
			if (notTracked.has(normalized)) continue;
			if (raw) unknownTokens.add(raw);
			continue;
		}
		mentions.set(employee.id, { name: employee.displayName, sentiment: candidate.sentiment });
	}

	return { mentions: [...mentions.values()], unknownTokens: [...unknownTokens].sort((a, b) => a.localeCompare(b, 'fr')) };
}
