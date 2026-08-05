import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, indexingCredentials, statusHistory } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { authorizeMachine, machineAuthError, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { planContentStatusChange, resolveContentStatusActor } from '$lib/server/content-status.js';
import { publishUrl } from '$lib/server/indexing.js';
import { scheduleIndexChecks } from '$lib/server/collectors/index-selection.js';
import { eq } from 'drizzle-orm';

// Statuts canoniques du hub + états de la machine du pipeline SEO autopilot.
// Le DB est en texte libre ; cette liste est la seule garde applicative.
const VALID_STATUSES = [
	'draft',
	'review',
	'approved',
	'published',
	// Pipeline SEO V2 (orchestrateur content-creator / article-producer)
	'brief_validated',
	'writing',
	'review_fail',
	'needs_human',
	'monitored'
];

export const PATCH: RequestHandler = async (event) => {
	const machineAuth = event.locals.user ? null : authorizeMachine(event, 'content:status');
	if (!event.locals.user && machineAuth && !machineAuth.ok) return machineAuthError(machineAuth);
	const changedBy = resolveContentStatusActor(
		event.locals.user ? { user: { id: event.locals.user.id, email: event.locals.user.email } } : null,
		machineAuth?.ok ? machineAuth.credential : null
	);
	if (!changedBy) return errorResponse('Unauthorized', 401);

	const body = await event.request.json();
	const { status } = body;

	if (!status || !VALID_STATUSES.includes(status)) {
		return errorResponse(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
	}

	const decision = await db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(contents)
			.where(eq(contents.id, event.params.id))
			.limit(1)
			.for('update');
		const content = rows[0];
		if (!content) return null;

		const plan = planContentStatusChange(content.status, status);
		if (!plan.changed) return { content, publishedAt: content.publishedAt, idempotent: true };

		const now = new Date().toISOString();
		const updates: Record<string, unknown> = { status, updatedAt: now };
		if (status === 'published' && !content.publishedAt) updates.publishedAt = now;
		const publishedAt = (updates.publishedAt as string | undefined) ?? content.publishedAt;
		if (status === 'published' && !content.plannedDate) updates.plannedDate = now.slice(0, 10);

		await tx.update(contents).set(updates).where(eq(contents.id, event.params.id));
		await tx.insert(statusHistory).values({
			id: createId(),
			contentId: event.params.id,
			fromStatus: content.status,
			toStatus: status,
			changedBy
		});
		return { content, publishedAt, idempotent: false };
	});

	if (!decision) return errorResponse('Content not found', 404);
	const { content, publishedAt, idempotent } = decision;
	if (idempotent) return jsonResponse({ id: event.params.id, status, idempotent: true });

	// Auto-submit a la Google Indexing API si configure pour ce projet.
	// IDX-008 : passe désormais par la garde d'éligibilité. Un contenu ordinaire n'a
	// pas de type éligible (JobPosting/BroadcastEvent) → refusé + audité, aucun réseau.
	// La voie normale d'indexation reste sitemap + maillage + inspection (SPEC §9.4).
	if (status === 'published' && content.status !== 'published') {
		const cred = await db.query.indexingCredentials.findFirst({
			where: eq(indexingCredentials.projectId, content.projectId)
		});
		if (cred?.autoSubmitOnPublish && cred.publicUrlTemplate && content.slug) {
			const publicUrl = cred.publicUrlTemplate.replace('{slug}', content.slug);
			publishUrl({
				projectId: content.projectId,
				url: publicUrl,
				type: 'URL_UPDATED',
				source: 'auto-publish'
				// pas d'eligibility : contenu ordinaire → garde IDX-008 le refuse et l'audite
			}).catch(() => { /* fire-and-forget, erreurs loggees en DB */ });
		}

		// IDX-004 lot 2 — vérifications d'indexation différées (J+3 / J+7 / J+28).
		//
		// PAS de condition sur `autoSubmitOnPublish` : ce drapeau gouverne la SOUMISSION à
		// l'Indexing API. Ne pas vouloir pousser une URL à Google ne veut pas dire ne pas
		// vouloir SAVOIR si elle est indexée — souvent l'inverse (même raison qui a écarté
		// `exclude_patterns` de la sélection au lot 1).
		//
		// Limité au type `article` : seul lui a une page sur le site du client. Un post GMB ou
		// LinkedIn paierait du quota d'inspection pour une URL qui n'existe pas.
		//
		// `await`, contrairement à `publishUrl` : c'est une écriture LOCALE, sans réseau ni
		// quota — la laisser filer masquerait une erreur de base. Mais sous garde : planifier
		// est le corollaire de publier, jamais sa condition.
		if (content.type === 'article' && cred?.publicUrlTemplate && content.slug && publishedAt) {
			const publicUrl = cred.publicUrlTemplate.replace('{slug}', content.slug);
			try {
				await scheduleIndexChecks({
					db,
					projectId: content.projectId,
					url: publicUrl,
					publishedAt,
					contentId: event.params.id
				});
			} catch (err) {
				console.error('[idx-004] échéances post-publication non posées', err);
			}
		}
	}

	return jsonResponse({ id: event.params.id, status });
};
