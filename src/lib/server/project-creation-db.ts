import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { entities, projects } from './db/schema.js';
import type { ProjectCreationDependencies } from './project-creation.js';

class CoreReconcilerError extends Error {
	retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'CoreReconcilerError';
		this.retryable = retryable;
	}
}

export const projectCreationDependencies: ProjectCreationDependencies = {
	async findProject(slug) {
		return (await db.query.projects.findFirst({
			columns: { id: true, slug: true },
			where: eq(projects.slug, slug)
		})) ?? null;
	},
	async findCoreEntity(slug) {
		const rows = await db.select({ id: entities.id, slug: entities.slug }).from(entities).where(eq(entities.slug, slug)).limit(1);
		return rows[0] ?? null;
	},
	async reconcileCoreEntity(input) {
		if (!env.CORE_RECONCILER_URL || !env.CORE_RECONCILER_TOKEN) {
			throw new CoreReconcilerError('Le reconciler core contrôlé n’est pas configuré.', false);
		}
		const response = await fetch(env.CORE_RECONCILER_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.CORE_RECONCILER_TOKEN}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': input.idempotencyKey
			},
			body: JSON.stringify({ slug: input.slug, display_name: input.displayName })
		}).catch((error) => {
			throw new CoreReconcilerError(`Reconciler core inaccessible: ${error instanceof Error ? error.message : 'network'}`, true);
		});
		if (!response.ok) {
			throw new CoreReconcilerError(`Reconciler core: HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
		}
		const payload = await response.json() as { id?: unknown; slug?: unknown };
		if (typeof payload.id !== 'string' || typeof payload.slug !== 'string') {
			throw new CoreReconcilerError('Réponse invalide du reconciler core.', false);
		}
		return { id: payload.id, slug: payload.slug };
	},
	async insertProject(project) {
		const inserted = await db.insert(projects).values({
			id: project.id,
			name: project.name,
			slug: project.slug,
			entityId: project.entityId,
			description: project.description ?? null,
			color: project.color ?? '#00D9A3',
			image: project.image ?? null,
			accessToken: project.accessToken
		}).onConflictDoNothing({ target: projects.slug }).returning({ id: projects.id });
		return inserted.length === 1;
	}
};
