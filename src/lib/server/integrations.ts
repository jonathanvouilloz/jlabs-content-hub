/**
 * DATA-002 — Intégrations projet (SPEC §7.1).
 *
 * Une intégration = un provider branché sur un projet pour une ressource donnée
 * (propriété GSC, localisation GMB…). Unique par (project_id, provider, resource_key)
 * → plusieurs propriétés/localisations sans collision.
 * ⚠️ Aucun secret ici : `secret_ref` pointe vers l'emplacement du secret ;
 * `configuration_json` est vérifié par `assertNoInlineSecret`.
 *
 * GSC-001 — deux corrections faites AVANT le premier écrivain réel :
 *
 *   - **horodatages au format DB** (`toDbTimestamp`) et non plus en ISO. Ces
 *     colonnes ont pour DEFAULT `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')` ; y
 *     écrire de l'ISO les rend incomparables lexicalement avec les lignes posées
 *     par le default (`'T'` 0x54 > `' '` 0x20), et `computeHealth` compare
 *     précisément `last_success_at` à `last_error_at`. Rien n'avait cassé PARCE QUE
 *     LA TABLE ÉTAIT VIDE (0 ligne) — exactement le scénario d'AGT-000 sur
 *     `proposals.ts`/`policies.ts` ;
 *   - **client injecté**, sinon aucune preuve hors runtime SvelteKit ne peut
 *     vérifier ce qui s'écrit ici.
 */
import { eq } from 'drizzle-orm';
import { projectIntegrations } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret, computeHealth } from './projection-state.js';

/** Cf. `findings.ts` : import dynamique, donc chargeable hors runtime SvelteKit. */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db as unknown as AppDb;
}

export interface UpsertIntegrationInput {
	projectId: string;
	provider: string;
	resourceKey?: string;
	enabled?: boolean;
	status?: string;
	scopes?: string | null;
	configurationJson?: string | null;
	secretRef?: string | null;
}

/** Crée ou met à jour une intégration (clé naturelle projet+provider+ressource). */
export async function upsertIntegration(
	input: UpsertIntegrationInput,
	client?: AppDb
): Promise<{ id: string }> {
	assertNoInlineSecret(input.configurationJson, 'configuration_json d’intégration');

	const db = await resolveDb(client);
	const resourceKey = input.resourceKey ?? '';
	const now = toDbTimestamp();
	const id = createId();

	const rows = await db
		.insert(projectIntegrations)
		.values({
			id,
			projectId: input.projectId,
			provider: input.provider,
			resourceKey,
			enabled: input.enabled ?? false,
			status: input.status ?? 'inactive',
			scopes: input.scopes ?? null,
			configurationJson: input.configurationJson ?? null,
			secretRef: input.secretRef ?? null
		})
		.onConflictDoUpdate({
			target: [projectIntegrations.projectId, projectIntegrations.provider, projectIntegrations.resourceKey],
			set: {
				enabled: input.enabled ?? false,
				status: input.status ?? 'inactive',
				scopes: input.scopes ?? null,
				configurationJson: input.configurationJson ?? null,
				secretRef: input.secretRef ?? null,
				updatedAt: now
			}
		})
		.returning({ id: projectIntegrations.id });

	return { id: rows[0]?.id ?? id };
}

/** Liste les intégrations d'un projet. */
export async function listIntegrations(projectId: string, client?: AppDb) {
	const db = await resolveDb(client);
	return db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, projectId));
}

/** Enregistre un succès : met à jour la fraîcheur et recalcule la santé. */
export async function recordIntegrationSuccess(id: string, client?: AppDb): Promise<void> {
	const db = await resolveDb(client);
	const now = toDbTimestamp();
	const rows = await db
		.select()
		.from(projectIntegrations)
		.where(eq(projectIntegrations.id, id))
		.limit(1);
	const row = rows[0];
	if (!row) return;
	await db
		.update(projectIntegrations)
		.set({
			lastSuccessAt: now,
			// Un succès rend l'intégration active : c'est la sortie d'erreur, et son
			// propriétaire est la collecte qui vient de réussir.
			status: 'active',
			healthStatus: computeHealth({ lastSuccessAt: now, lastErrorAt: row.lastErrorAt }),
			updatedAt: now
		})
		.where(eq(projectIntegrations.id, id));
}

/** Enregistre une erreur : met à jour la fraîcheur, le code et recalcule la santé. */
export async function recordIntegrationError(
	id: string,
	errorCode: string,
	client?: AppDb
): Promise<void> {
	const db = await resolveDb(client);
	const now = toDbTimestamp();
	const rows = await db
		.select()
		.from(projectIntegrations)
		.where(eq(projectIntegrations.id, id))
		.limit(1);
	const row = rows[0];
	if (!row) return;
	await db
		.update(projectIntegrations)
		.set({
			lastErrorAt: now,
			lastErrorCode: errorCode,
			status: 'error',
			healthStatus: computeHealth({ lastSuccessAt: row.lastSuccessAt, lastErrorAt: now }),
			updatedAt: now
		})
		.where(eq(projectIntegrations.id, id));
}
