import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import {
	computeActions,
	computeCannibalization,
	computePositionMovers,
	getDiff,
	listSnapshots
} from '$lib/server/gsc-analytics.js';
import { buildAgentProjectInsights } from '$lib/server/agent-project-insights-state.js';
import type { RequestHandler } from './$types.js';

/**
 * Lecture bornée pour Hermes : aucun accès SQL ni endpoint d'écriture. Le bearer
 * doit porter le scope dédié ET déclarer explicitement le slug demandé.
 */
export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'agent:insights:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);

	const project = await db.query.projects.findFirst({
		columns: { id: true, slug: true, name: true },
		where: eq(projects.slug, event.params.slug)
	});
	if (!project || project.slug !== event.params.slug) {
		return json({ ok: false, error: 'project_not_found' }, { status: 404 });
	}

	const snapshot = (await listSnapshots(project.id, 1))[0] ?? null;
	if (!snapshot) {
		return json({ ok: true, data: buildAgentProjectInsights({
			project: { slug: project.slug, name: project.name },
			snapshot: null,
			diff: null,
			actions: { opportunities: [], quickWins: [] },
			movers: { gains: [], losses: [] },
			cannibalization: []
		}) });
	}

	const [diff, actions, movers, cannibalization] = await Promise.all([
		getDiff(project.id, snapshot.weekStart),
		computeActions({ projectId: project.id, weekStart: snapshot.weekStart, limit: 10 }),
		computePositionMovers({ projectId: project.id, weekStart: snapshot.weekStart, limit: 10 }),
		computeCannibalization({ projectId: project.id, weekStart: snapshot.weekStart, limit: 10 })
	]);

	return json({
		ok: true,
		data: buildAgentProjectInsights({
			project: { slug: project.slug, name: project.name },
			snapshot,
			diff,
			actions,
			movers,
			cannibalization
		})
	});
};
