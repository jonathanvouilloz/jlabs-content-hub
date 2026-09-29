/**
 * Contrat de réponse commun à `POST …/publish` et `GET …/reconcile`.
 *
 * Le champ canonique est `state`, toujours à la racine de `data`, quel que soit l'état
 * et l'endpoint. Avant, publish le rangeait sous `data.result.state` et reconcile sous
 * `data.state` : un client qui ne lisait qu'une profondeur lisait l'autre `unknown`
 * (incident Hermes du 2026-09-29, `de76afbef07f442e1b074a82`).
 *
 * `write_unknown` n'autorise qu'un geste : relire par `GET …/reconcile`. Jamais un
 * second `POST …/publish`.
 */
export type AgentPublicationState = 'verified' | 'conflict' | 'write_unknown' | 'retry_eligible';

export type AgentPublicationOutcome =
	| { state: 'verified' }
	| { state: 'conflict'; reason: 'remote_reply_differs' | 'review_missing' | 'snapshot_changed' }
	| { state: 'write_unknown'; error?: string; reason?: 'awaiting_remote_propagation'; retryAfterSeconds?: number }
	| { state: 'retry_eligible' };

export interface AgentPublicationResponse {
	state: AgentPublicationState;
	reason?: string;
	error?: string;
	retryAfterSeconds?: number;
	idempotent: boolean;
}

export function toPublicationResponse(
	outcome: AgentPublicationOutcome,
	options: { idempotent: boolean }
): AgentPublicationResponse {
	const response: AgentPublicationResponse = { state: outcome.state, idempotent: options.idempotent };
	if ('reason' in outcome && outcome.reason) response.reason = outcome.reason;
	if ('error' in outcome && outcome.error) response.error = outcome.error;
	if ('retryAfterSeconds' in outcome && typeof outcome.retryAfterSeconds === 'number') {
		response.retryAfterSeconds = outcome.retryAfterSeconds;
	}
	return response;
}

/**
 * Réponse de publish : le contrat commun, plus `result` en alias DÉPRÉCIÉ de l'ancienne
 * forme (`data.result.state`) pour les clients déjà déployés.
 */
export function toPublishResponse(
	outcome: AgentPublicationOutcome,
	options: { idempotent: boolean }
): AgentPublicationResponse & { result: Omit<AgentPublicationResponse, 'idempotent'> } {
	const response = toPublicationResponse(outcome, options);
	const { idempotent: _idempotent, ...legacy } = response;
	return { ...response, result: legacy };
}
