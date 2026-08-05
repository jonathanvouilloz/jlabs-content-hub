import { createClientToken } from './client-token.js';
import { createId } from './utils.js';

export interface CoreEntityRef { id: string; slug: string }
export interface ProjectCreationInput {
	name: string;
	slug: string;
	description?: string | null;
	color?: string | null;
	image?: string | null;
}
export interface ProjectInsert extends ProjectCreationInput {
	id: string;
	entityId: string;
	accessToken: string;
}
export interface ProjectCreationDependencies {
	findProject(slug: string): Promise<{ id: string; slug: string } | null>;
	findCoreEntity(slug: string): Promise<CoreEntityRef | null>;
	reconcileCoreEntity(input: { slug: string; displayName: string; idempotencyKey: string }): Promise<CoreEntityRef>;
	insertProject(project: ProjectInsert): Promise<boolean>;
}

export type ProjectCreationResult =
	| { id: string; slug: string; reused: true }
	| { id: string; slug: string; reused: false; accessToken: string; accessTokenExpiresAt: string };

async function reconcileWithRetry(
	input: { slug: string; displayName: string; idempotencyKey: string },
	deps: ProjectCreationDependencies,
	retryDelayMs: number
): Promise<CoreEntityRef> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await deps.reconcileCoreEntity(input);
		} catch (error) {
			lastError = error;
			if (!(error && typeof error === 'object' && 'retryable' in error && error.retryable === true) || attempt === 2) throw error;
			if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
		}
	}
	throw lastError;
}

export async function createProjectProjection(
	input: ProjectCreationInput,
	deps: ProjectCreationDependencies,
	options: { retryDelayMs?: number; now?: Date } = {}
): Promise<ProjectCreationResult> {
	const existing = await deps.findProject(input.slug);
	if (existing) return { ...existing, reused: true };

	const entity = (await deps.findCoreEntity(input.slug)) ?? await reconcileWithRetry({
		slug: input.slug,
		displayName: input.name,
		idempotencyKey: `seo-project:${input.slug}`
	}, deps, options.retryDelayMs ?? 100);
	if (entity.slug !== input.slug) throw new Error('Le reconciler core a retourné un slug canonique différent.');

	const id = createId();
	const token = createClientToken(options.now);
	const inserted = await deps.insertProject({
		...input,
		id,
		entityId: entity.id,
		color: input.color ?? '#00D9A3',
		accessToken: token.stored
	});
	if (!inserted) {
		const winner = await deps.findProject(input.slug);
		if (!winner) throw new Error('Création concurrente détectée sans projection relisible.');
		return { ...winner, reused: true };
	}
	return {
		id,
		slug: input.slug,
		reused: false,
		accessToken: token.raw,
		accessTokenExpiresAt: token.expiresAt.toISOString()
	};
}
