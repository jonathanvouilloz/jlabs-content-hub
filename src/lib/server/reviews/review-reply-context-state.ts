/**
 * GMB-003 — le contexte qu'une réponse d'avis a le droit d'utiliser.
 *
 * ⚠️ LE POINT DU MODULE : il n'y a qu'UN roster, et ce n'est pas celui-ci.
 *
 * La première version lisait `gmb.reviewReplies.publicRoster[]` (`name` / `locationIds`)
 * alors que `parseEmployeeMentionsCapability` lit déjà `gmb.employeeMentions.employees[]`
 * (`displayName` / `locations`). Deux listes de personnes dans la même projection, pour le
 * même salon, remplies à la main : elles divergent, et c'est exactement le défaut mesuré en
 * juillet 2026 — Issam et Santos manquaient au roster avec 4 mentions chacun, et personne ne
 * pouvait le voir. Une IA qui répond avec un roster troué écrit « on transmet à ton barbier »
 * à un client qui vient de nommer quelqu'un.
 *
 * Le roster publiable est donc DÉRIVÉ du roster canonique, jamais saisi deux fois. Ajouter
 * une personne à `employeeMentions` la rend citable ici sans second geste ; la retirer la
 * retire des deux côtés. Les deux vues ne peuvent plus se contredire parce qu'il n'y a plus
 * deux sources.
 *
 * Deuxième invariant : une projection qui n'est pas `current` ne sert à rien ici. `stale`
 * veut dire que la source a bougé sans être recompilée, `invalid` que la compilation a
 * échoué. Répondre publiquement au nom d'un salon sur un contexte périmé est précisément ce
 * que l'acceptation GMB-003 interdit (« un contexte stale force la validation »).
 */
import {
	parseEmployeeMentionsCapability,
	type EmployeeMentionsRoster
} from './employee-mentions-state.js';

export interface PublicRosterMember {
	/** Identité canonique — celle du roster, jamais une graphie trouvée dans l'avis. */
	name: string;
	aliases: string[];
}

export interface ReviewReplyVoice {
	tutoiement: boolean;
	/** Mots que la marque n'emploie pas (« atelier » pour un salon, par exemple). */
	banned: string[];
}

export interface ReviewReplyContext {
	version: string;
	businessName: string;
	defaultSignature: string;
	contactEmail: string;
	locationLabel: string;
	voice: ReviewReplyVoice;
	interdits: string[];
	/**
	 * Version du roster canonique, distincte de celle du contexte : les deux capabilities se
	 * promeuvent séparément. La faire remonter évite d'attribuer une réponse au mauvais état
	 * d'équipe quand on relit un candidat des semaines plus tard.
	 */
	rosterVersion: string | null;
	/**
	 * `false` = aucun roster exploitable pour CETTE fiche. Ce n'est pas une erreur — une
	 * réponse sans nom reste correcte — mais ça ne doit pas se lire « personne n'y travaille ».
	 */
	rosterAvailable: boolean;
	publicRoster: PublicRosterMember[];
}

export type ReviewReplyContextResult =
	| { ok: true; context: ReviewReplyContext }
	| {
			ok: false;
			reason: 'context_missing' | 'context_invalid' | 'location_missing' | 'projection_stale';
	  };

/** Statuts de `project_projections.status`. Seul `current` autorise une réponse publique. */
export type ProjectionStatus = 'current' | 'stale' | 'invalid';

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
		: [];
}

/**
 * Le roster publiable d'UNE fiche, dérivé du roster canonique.
 *
 * Trois conditions cumulatives, et l'oubli de n'importe laquelle publie le nom de quelqu'un
 * là où il ne travaille pas, ou qui a demandé à ne pas être cité.
 */
export function derivePublicRoster(
	roster: EmployeeMentionsRoster | null,
	locationId: string
): PublicRosterMember[] {
	if (!roster?.enabled) return [];
	return roster.employees
		.filter(
			(employee) =>
				employee.active &&
				employee.publicReplyAllowed &&
				employee.locations.includes(locationId)
		)
		.map((employee) => ({
			name: employee.displayName,
			aliases: [...employee.aliases].filter((alias) => alias.trim().length > 0)
		}));
}

/**
 * Lit la projection de réponse d'avis pour une fiche donnée. Toute forme incomplète échoue
 * fermée : le rédacteur n'a jamais à deviner un établissement, une signature ou une personne.
 */
export function parseReviewReplyContext(
	payload: unknown,
	locationId: string,
	projectionStatus: ProjectionStatus = 'current'
): ReviewReplyContextResult {
	if (projectionStatus !== 'current') return { ok: false, reason: 'projection_stale' };

	const root = asRecord(payload);
	const gmb = asRecord(root?.gmb);
	const replies = asRecord(gmb?.reviewReplies);
	if (!replies) return { ok: false, reason: 'context_missing' };

	const version = asNonEmptyString(replies.version);
	const businessName = asNonEmptyString(replies.businessName);
	const defaultSignature = asNonEmptyString(replies.defaultSignature);
	const contactEmail = asNonEmptyString(replies.contactEmail);
	if (!version || !businessName || !defaultSignature || !contactEmail) {
		return { ok: false, reason: 'context_invalid' };
	}

	const locations = Array.isArray(replies.locations) ? replies.locations : null;
	const location = locations?.map(asRecord).find((entry) => entry?.id === locationId);
	const locationLabel = asNonEmptyString(location?.label);
	if (!locationLabel) return { ok: false, reason: 'location_missing' };

	const voiceRecord = asRecord(replies.voice);
	const voice: ReviewReplyVoice = {
		tutoiement: voiceRecord?.tutoiement === true,
		banned: asStringList(voiceRecord?.banned)
	};

	const capability = parseEmployeeMentionsCapability(payload);
	const publicRoster = derivePublicRoster(capability.roster, locationId);

	return {
		ok: true,
		context: {
			version,
			businessName,
			defaultSignature,
			contactEmail,
			locationLabel,
			voice,
			interdits: asStringList(replies.interdits),
			rosterVersion: capability.roster?.version ?? null,
			rosterAvailable: publicRoster.length > 0,
			publicRoster
		}
	};
}
