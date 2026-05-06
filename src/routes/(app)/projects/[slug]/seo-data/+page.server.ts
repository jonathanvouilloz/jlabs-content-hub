import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { indexingCredentials } from '$lib/server/db/schema.js';
import {
	getDiff,
	getSnapshot,
	latestCompleteWeekStart,
	listSnapshots
} from '$lib/server/gsc-analytics.js';
import type { PageServerLoad } from './$types.js';

function isValidWeekStart(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	return d.getUTCDay() === 1;
}

export const load: PageServerLoad = async ({ parent, url }) => {
	const { project } = await parent();

	const cred = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, project.id)
	});
	const hasGsc = !!cred?.siteUrl;

	const history = hasGsc ? await listSnapshots(project.id, 52) : [];

	const queryWeek = url.searchParams.get('week');
	let weekStart: string;
	if (queryWeek && isValidWeekStart(queryWeek)) {
		weekStart = queryWeek;
	} else if (history.length > 0) {
		weekStart = history[0].weekStart;
	} else {
		weekStart = latestCompleteWeekStart();
	}

	const [snapshot, diff] = hasGsc
		? await Promise.all([getSnapshot(project.id, weekStart), getDiff(project.id, weekStart)])
		: [null, null];

	if (queryWeek && !isValidWeekStart(queryWeek)) {
		throw error(400, 'Param "week" invalide (doit être un lundi YYYY-MM-DD)');
	}

	return {
		hasGsc,
		siteUrl: cred?.siteUrl ?? null,
		weekStart,
		snapshot,
		diff,
		history
	};
};
