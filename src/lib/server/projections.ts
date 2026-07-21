/**
 * DATA-002 — Projections de contexte (SPEC §3.2/§7.2).
 *
 * Une projection est un contexte projet compilé, hashé et versionné. Règles :
 *   - même `source_hash` re-soumis → no-op (`deduped`), jamais de doublon ;
 *   - hash différent → nouvelle version : l'ancienne `current` passe `stale`,
 *     la nouvelle devient `current` (ou `invalid` si erreurs de validation) ;
 *   - aucun secret n'est accepté dans le payload (`assertNoInlineSecret`).
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { projectProjections } from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret, classifyProjection } from './projection-state.js';

export interface RecordProjectionInput {
	projectId: string;
	sourceHash: string;
	payload: string;
	schemaVersion?: number;
	compiledAt?: string | null;
	validationErrors?: string | null;
}

export interface RecordProjectionResult {
	deduped: boolean;
	id: string;
	/** id de la projection précédemment `current` passée `stale` (si remplacement). */
	supersededId?: string;
}

/** Projection actuellement `current` d'un projet (ou undefined). */
export async function getCurrentProjection(projectId: string) {
	return db.query.projectProjections.findFirst({
		where: and(eq(projectProjections.projectId, projectId), eq(projectProjections.status, 'current'))
	});
}

/**
 * Enregistre une projection. Dédup par `source_hash` ; versionne sinon. Le
 * remplacement (stale → insert current) est transactionnel pour préserver
 * l'invariant « une seule projection courante par projet ».
 */
export async function recordProjection(input: RecordProjectionInput): Promise<RecordProjectionResult> {
	assertNoInlineSecret(input.payload, 'payload de projection');

	const current = await getCurrentProjection(input.projectId);

	if (classifyProjection({ incomingHash: input.sourceHash, currentHash: current?.sourceHash }) === 'duplicate') {
		return { deduped: true, id: current!.id };
	}

	const id = createId();
	const status = input.validationErrors ? 'invalid' : 'current';

	await db.transaction(async (tx) => {
		if (current) {
			await tx
				.update(projectProjections)
				.set({ status: 'stale' })
				.where(eq(projectProjections.id, current.id));
		}
		await tx.insert(projectProjections).values({
			id,
			projectId: input.projectId,
			schemaVersion: input.schemaVersion ?? 1,
			sourceHash: input.sourceHash,
			payload: input.payload,
			status,
			validationErrors: input.validationErrors ?? null,
			compiledAt: input.compiledAt ?? null
		});
	});

	return { deduped: false, id, supersededId: current?.id };
}

/** Marque la projection courante d'un projet comme `stale` (ex. hash source divergent). */
export async function markStale(projectId: string): Promise<void> {
	await db
		.update(projectProjections)
		.set({ status: 'stale' })
		.where(and(eq(projectProjections.projectId, projectId), eq(projectProjections.status, 'current')));
}
