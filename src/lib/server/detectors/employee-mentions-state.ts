import { deriveFindingFingerprint } from '../finding-state.js';
import { normalizeRosterToken } from '../reviews/employee-mentions-state.js';

export const DETECTOR_EMPLOYEE_MENTIONS = 'employee_mentions@1';
export const UNKNOWN_EMPLOYEE_MENTION_TYPE = 'unknown_employee_mention';
export const EMPLOYEE_MENTION_ENTITY_TYPE = 'review';

/**
 * Un nom qui n'est pas dans le roster est un signal de gouvernance, pas une
 * attribution. Le fingerprint inclut la version : une correction de roster peut
 * donc être revue sans effacer l'observation antérieure.
 */
export function buildUnknownEmployeeMentionFinding(input: {
	projectId: string;
	reviewId: string;
	locationId: string;
	token: string;
	rosterVersion: string;
}) {
	const token = input.token.trim();
	const normalized = normalizeRosterToken(token);
	const fingerprint = deriveFindingFingerprint({
		type: UNKNOWN_EMPLOYEE_MENTION_TYPE,
		entityType: EMPLOYEE_MENTION_ENTITY_TYPE,
		entityKey: input.reviewId,
		discriminators: [input.locationId, input.rosterVersion, normalized]
	});
	return {
		type: UNKNOWN_EMPLOYEE_MENTION_TYPE,
		fingerprint,
		title: `Nom d’employé inconnu détecté (${token})`,
		severity: 'low' as const,
		evidence: { locationId: input.locationId, rosterVersion: input.rosterVersion, token },
		eventPayload: {
			detector: DETECTOR_EMPLOYEE_MENTIONS,
			locationId: input.locationId,
			rosterVersion: input.rosterVersion,
			token
		}
	};
}
