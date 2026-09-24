import { describe, expect, it } from 'vitest';
import {
	buildSeoWeeklyDispatchEvents,
	parseSeoWeeklyDispatchEvent
} from './seo-weekly-dispatch-state.js';
import type { PublicationReadiness } from './report-publication-state.js';

const readiness: PublicationReadiness = {
	periodSlot: '2026-08-03T09:00',
	deadlineMinutes: 60,
	expected: 4,
	ready: 1,
	degraded: 1,
	waiting: 1,
	missing: 0,
	paused: ['paused-client'],
	blockers: ['waiting-client'],
	incidents: [
		{ projectSlug: 'degraded-client', kind: 'degraded', detail: 'run partial' },
		{ projectSlug: 'waiting-client', kind: 'waiting', detail: 'still running' }
	],
	byProject: [
		{ projectSlug: 'waiting-client', state: 'waiting', runStatus: 'running', runId: 'run-wait', note: null },
		{ projectSlug: 'physiopommier', state: 'ready', runStatus: 'success', runId: 'run-physio', note: null },
		{ projectSlug: 'paused-client', state: 'paused', runStatus: null, runId: null, note: 'pause' },
		{ projectSlug: 'degraded-client', state: 'degraded', runStatus: 'partial', runId: 'run-degraded', note: 'partial' },
		{ projectSlug: 'invalid-ready', state: 'ready', runStatus: 'success', runId: null, note: null }
	]
};

describe('SEO weekly dispatch state', () => {
	it('ne produit que les événements ready ou degraded qui portent un run terminal', () => {
		const events = buildSeoWeeklyDispatchEvents({
			readiness,
			reportId: 'report-1',
			revision: 1,
			baseUrl: 'https://hubseo.jonlabs.ch/'
		});

		expect(events.map((event) => event.projectSlug)).toEqual([
			'degraded-client',
			'physiopommier'
		]);
		expect(events[0].runStatus).toBe('partial');
		expect(events[1].runStatus).toBe('success');
	});

	it('produit des identités, clés et URLs déterministes par slot, révision et slug', () => {
		const [degraded, physio] = buildSeoWeeklyDispatchEvents({
			readiness,
			reportId: 'report-1',
			revision: 3,
			baseUrl: 'https://hubseo.jonlabs.ch'
		});

		expect(physio).toMatchObject({
			eventType: 'seo.weekly_report.published',
			eventId: 'seo-weekly:2026-08-03T09:00:r3:physiopommier',
			idempotencyKey: 'seo-weekly-dispatch:2026-08-03T09:00:r3:physiopommier',
			periodSlot: '2026-08-03T09:00',
			revision: 3,
			reportId: 'report-1',
			runId: 'run-physio',
			snapshotUrl:
				'https://hubseo.jonlabs.ch/api/agent/reports/2026-08-03T09%3A00/projects/physiopommier?revision=3'
		});
		expect(degraded.schemaVersion).toBe(1);
	});

	it('valide strictement le payload relu depuis la queue', () => {
		const event = buildSeoWeeklyDispatchEvents({
			readiness,
			reportId: 'report-1',
			revision: 1,
			baseUrl: 'https://hubseo.jonlabs.ch'
		})[0];
		expect(parseSeoWeeklyDispatchEvent(JSON.stringify(event))).toEqual(event);
		expect(() => parseSeoWeeklyDispatchEvent('{"eventType":"wrong"}')).toThrow(
			'payload dispatch SEO hebdomadaire invalide'
		);
		expect(() => parseSeoWeeklyDispatchEvent('not-json')).toThrow(
			'payload dispatch SEO hebdomadaire invalide'
		);
	});
});
