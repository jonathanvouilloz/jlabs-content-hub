import { describe, expect, it } from 'vitest';
import {
	buildProjectWeeklySnapshot,
	renderProjectWeeklySnapshotMarkdown
} from './project-weekly-snapshot-state.js';
import type { WeeklyReport } from './weekly-report-state.js';
import type { PublicationReadiness } from './report-publication-state.js';

const report: WeeklyReport = {
	schemaVersion: 2,
	generatedAt: '2026-08-03 12:02:56',
	period: {
		sinceDb: '2026-07-27 07:00:00',
		untilDb: '2026-08-03 07:00:00',
		windowDays: 7,
		label: '27 juillet → 3 août 2026'
	},
	headline: '9 projets prêts',
	coverage: [
		{ projectSlug: 'physiopommier', reason: 'partially_examined', note: 'Plausible non branché' },
		{ projectSlug: 'wildcat', reason: 'never_examined', note: 'Jamais examiné' }
	],
	sections: [
		{
			key: 'opportunities',
			title: 'Opportunités à fort impact',
			body: {
				available: true,
				data: {
					metrics: [],
					items: [
						{
							label: 'Opportunité « physio nations »',
							detail: 'position 8,4 · 52 impressions · 0 clic',
							projectSlug: 'physiopommier',
							rank: 64,
							source: { kind: 'finding', id: 'finding-1', href: '/inbox/findings/finding-1' }
						},
						{
							label: 'Autre projet',
							detail: null,
							projectSlug: 'wildcat',
							rank: 50,
							source: { kind: 'finding', id: 'finding-2', href: '/inbox/findings/finding-2' }
						}
					],
					truncated: 0,
					blindSpots: [],
					note: null
				}
			}
		},
		{
			key: 'traffic_conversions',
			title: 'Trafic et conversions',
			body: { available: false, reason: 'not_wired', detail: 'Plausible non branché' }
		}
	]
};

const readiness: PublicationReadiness = {
	periodSlot: '2026-08-03T09:00',
	deadlineMinutes: 300,
	expected: 2,
	ready: 2,
	degraded: 0,
	waiting: 0,
	missing: 0,
	paused: [],
	byProject: [
		{
			projectSlug: 'physiopommier',
			state: 'ready',
			runStatus: 'success',
			runId: 'run-physio',
			note: null
		},
		{
			projectSlug: 'wildcat',
			state: 'ready',
			runStatus: 'success',
			runId: 'run-wildcat',
			note: null
		}
	],
	blockers: [],
	incidents: []
};

describe('project weekly snapshot', () => {
	it('projette uniquement les éléments et réserves du projet demandé', () => {
		const snapshot = buildProjectWeeklySnapshot({
			report,
			readiness,
			periodSlot: '2026-08-03T09:00',
			revision: 1,
			reportStatus: 'complete',
			projectSlug: 'physiopommier'
		});

		expect(snapshot.eventId).toBe('seo-weekly:2026-08-03T09:00:r1:physiopommier');
		expect(snapshot.readiness).toMatchObject({ state: 'ready', runId: 'run-physio' });
		expect(snapshot.coverage).toEqual([
			{ projectSlug: 'physiopommier', reason: 'partially_examined', note: 'Plausible non branché' }
		]);
		expect(snapshot.sections[0]?.items).toHaveLength(1);
		expect(snapshot.sections[0]?.items[0]?.label).toContain('physio nations');
		expect(JSON.stringify(snapshot)).not.toContain('wildcat');
	});

	it('rend un Markdown immuable avec chiffres, preuves et identité source', () => {
		const snapshot = buildProjectWeeklySnapshot({
			report,
			readiness,
			periodSlot: '2026-08-03T09:00',
			revision: 1,
			reportStatus: 'complete',
			projectSlug: 'physiopommier'
		});
		const markdown = renderProjectWeeklySnapshotMarkdown(snapshot, {
			hubBaseUrl: 'https://hubseo.jonlabs.ch'
		});

		expect(markdown).toContain('event_id: "seo-weekly:2026-08-03T09:00:r1:physiopommier"');
		expect(markdown).toContain('position 8,4 · 52 impressions · 0 clic');
		expect(markdown).toContain('https://hubseo.jonlabs.ch/inbox/findings/finding-1');
		expect(markdown).toContain('Snapshot daté : les données actuelles restent dans SEO Stats');
	});

	it('refuse un projet absent du périmètre de préparation', () => {
		expect(() =>
			buildProjectWeeklySnapshot({
				report,
				readiness,
				periodSlot: '2026-08-03T09:00',
				revision: 1,
				reportStatus: 'complete',
				projectSlug: 'inconnu'
			})
		).toThrow(/absent du rapport/);
	});
});
