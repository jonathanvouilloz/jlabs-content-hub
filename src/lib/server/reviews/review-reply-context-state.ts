export interface PublicRosterMember {
	name: string;
	aliases: string[];
}

export interface ReviewReplyContext {
	version: string;
	businessName: string;
	defaultSignature: string;
	contactEmail: string;
	locationLabel: string;
	publicRoster: PublicRosterMember[];
}

export type ReviewReplyContextResult =
	| { ok: true; context: ReviewReplyContext }
	| { ok: false; reason: 'context_missing' | 'context_invalid' | 'location_missing' };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Lit une projection versionnée du contexte de réponse GMB. Toute forme incomplète
 * échoue fermée : le sender n'a jamais à deviner une localisation ou une personne.
 */
export function parseReviewReplyContext(payload: unknown, locationId: string): ReviewReplyContextResult {
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
	const location = locations
		?.map(asRecord)
		.find((entry) => entry?.id === locationId);
	const locationLabel = asNonEmptyString(location?.label);
	if (!locationLabel) return { ok: false, reason: 'location_missing' };

	const publicRoster: PublicRosterMember[] = (Array.isArray(replies.publicRoster) ? replies.publicRoster : [])
		.map(asRecord)
		.flatMap((member) => {
			if (!member || member.publicReplyAllowed !== true) return [];
			const name = asNonEmptyString(member.name);
			const locationIds = Array.isArray(member.locationIds)
				? member.locationIds.filter((id): id is string => typeof id === 'string')
				: [];
			if (!name || !locationIds.includes(locationId)) return [];
			const aliases = Array.isArray(member.aliases)
				? member.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0).map((alias) => alias.trim())
				: [];
			return [{ name, aliases }];
		});

	return {
		ok: true,
		context: { version, businessName, defaultSignature, contactEmail, locationLabel, publicRoster }
	};
}
