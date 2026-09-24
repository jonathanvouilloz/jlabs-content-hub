import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { authorizeMachine, machineAuthError } from '$lib/server/api-auth.js';
import { loadPublishedReport } from '$lib/server/report-publication.js';
import {
	buildProjectWeeklySnapshot,
	renderProjectWeeklySnapshotMarkdown
} from '$lib/server/project-weekly-snapshot-state.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachine(event, 'monitor:read');
	if (!auth.ok) return machineAuthError(auth);

	const rawRevision = Number(event.url.searchParams.get('revision'));
	const revision = Number.isInteger(rawRevision) && rawRevision > 0 ? rawRevision : undefined;
	const published = await loadPublishedReport({
		db,
		periodSlot: event.params.slot,
		...(revision === undefined ? {} : { revision })
	});
	if (!published) return json({ ok: false, error: 'report_not_found' }, { status: 404 });
	if (!published.readiness) {
		return json({ ok: false, error: 'report_readiness_missing' }, { status: 409 });
	}
	if (published.detail.kind !== 'available') {
		return json(
			{ ok: false, error: 'report_detail_archived', archiveRef: published.detail.archiveRef },
			{ status: 410 }
		);
	}

	try {
		const snapshot = buildProjectWeeklySnapshot({
			report: published.detail.report,
			readiness: published.readiness,
			periodSlot: published.periodSlot,
			revision: published.revision,
			reportStatus: published.status,
			projectSlug: event.params.slug
		});
		const hubBaseUrl = event.url.origin;
		return json({
			ok: true,
			data: {
				snapshot,
				markdown: renderProjectWeeklySnapshotMarkdown(snapshot, { hubBaseUrl })
			}
		});
	} catch {
		return json({ ok: false, error: 'project_not_in_report' }, { status: 404 });
	}
};
