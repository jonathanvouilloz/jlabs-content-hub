/**
 * DATA-002 — Intégrations projet (SPEC §7.1).
 *
 * Une intégration = un provider branché sur un projet pour une ressource donnée
 * (propriété GSC, localisation GMB…). Unique par (project_id, provider, resource_key)
 * → plusieurs propriétés/localisations sans collision.
 * ⚠️ Aucun secret ici : `secret_ref` pointe vers l'emplacement du secret ;
 * `configuration_json` est vérifié par `assertNoInlineSecret`.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { projectIntegrations } from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret, computeHealth } from './projection-state.js';

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
export async function upsertIntegration(input: UpsertIntegrationInput): Promise<{ id: string }> {
	assertNoInlineSecret(input.configurationJson, 'configuration_json d’intégration');

	const resourceKey = input.resourceKey ?? '';
	const now = new Date().toISOString();
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
export async function listIntegrations(projectId: string) {
	return db.query.projectIntegrations.findMany({
		where: eq(projectIntegrations.projectId, projectId)
	});
}

/** Enregistre un succès : met à jour la fraîcheur et recalcule la santé. */
export async function recordIntegrationSuccess(id: string): Promise<void> {
	const now = new Date().toISOString();
	const row = await db.query.projectIntegrations.findFirst({ where: eq(projectIntegrations.id, id) });
	if (!row) return;
	await db
		.update(projectIntegrations)
		.set({
			lastSuccessAt: now,
			healthStatus: computeHealth({ lastSuccessAt: now, lastErrorAt: row.lastErrorAt }),
			updatedAt: now
		})
		.where(eq(projectIntegrations.id, id));
}

/** Enregistre une erreur : met à jour la fraîcheur, le code et recalcule la santé. */
export async function recordIntegrationError(id: string, errorCode: string): Promise<void> {
	const now = new Date().toISOString();
	const row = await db.query.projectIntegrations.findFirst({ where: eq(projectIntegrations.id, id) });
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
