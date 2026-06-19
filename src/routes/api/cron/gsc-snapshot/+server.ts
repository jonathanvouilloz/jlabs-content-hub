import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { projects, indexingCredentials } from '$lib/server/db/schema.js';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import {
	pullWeeklySnapshot,
	computeWeeklyDiff,
	latestCompleteWeekStart
} from '$lib/server/gsc-analytics.js';
import { sendCriticalError } from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/**
 * Cron hebdo (lundi 6h30) : pull du snapshot GSC de la dernière semaine complète
 * pour chaque projet configuré (indexingCredentials.siteUrl renseigné), puis diff N vs N-1.
 *
 * Idempotent : pullWeeklySnapshot renvoie reused=true si la semaine est déjà pull.
 * Isolation : un projet qui échoue n'interrompt pas le batch ; une erreur déclenche
 * un email critique dédupliqué (1h) via sendCriticalError.
 */
export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const weekStart = latestCompleteWeekStart();

	const targets = await db
		.select({ id: projects.id, slug: projects.slug })
		.from(projects)
		.innerJoin(indexingCredentials, eq(indexingCredentials.projectId, projects.id))
		.where(
			and(
				eq(projects.archived, false),
				isNotNull(indexingCredentials.siteUrl),
				ne(indexingCredentials.siteUrl, '')
			)
		);

	const failed: Array<{ slug: string; error: string }> = [];
	let succeeded = 0;

	for (const project of targets) {
		try {
			await pullWeeklySnapshot({ projectId: project.id, weekStart });
			await computeWeeklyDiff({ projectId: project.id, weekStart });
			succeeded++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			failed.push({ slug: project.slug, error: msg });
			// Email critique dédupliqué (1h) — n'interrompt pas le batch
			await sendCriticalError(`gsc-snapshot:${project.slug}`, msg);
		}
	}

	return json({
		ok: true,
		weekStart,
		processed: targets.length,
		succeeded,
		failed
	});
};
