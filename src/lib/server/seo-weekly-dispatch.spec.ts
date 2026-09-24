import { describe, expect, it, vi } from 'vitest';
import { queueSeoWeeklyDispatches } from './seo-weekly-dispatch.js';
import type { PublicationReadiness } from './report-publication-state.js';

const readiness: PublicationReadiness = {
	periodSlot: '2026-08-03T09:00',
	deadlineMinutes: 60,
	expected: 2,
	ready: 1,
	degraded: 1,
	waiting: 0,
	missing: 0,
	paused: [],
	blockers: [],
	incidents: [],
	byProject: [
		{ projectSlug: 'physiopommier', state: 'ready', runStatus: 'success', runId: 'run-1', note: null },
		{ projectSlug: 'barberconcept', state: 'degraded', runStatus: 'partial', runId: 'run-2', note: 'partial' }
	]
};

describe('queue SEO weekly dispatches', () => {
	it('reste totalement inerte quand le feature flag est désactivé', async () => {
		const loadProjectIds = vi.fn();
		const enqueue = vi.fn();
		const result = await queueSeoWeeklyDispatches(
			{
				enabled: false,
				readiness,
				reportId: 'report-1',
				revision: 1,
				baseUrl: 'https://hubseo.jonlabs.ch'
			},
			{ loadProjectIds, enqueue }
		);
		expect(result).toEqual({ eligible: 0, created: 0, existing: 0, missingProjects: [] });
		expect(loadProjectIds).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('met en file un job indépendant par projet autorisé sans secret ni run parent', async () => {
		const enqueue = vi
			.fn()
			.mockResolvedValueOnce({ created: true, id: 'job-1' })
			.mockResolvedValueOnce({ created: false, id: 'job-2' });
		const result = await queueSeoWeeklyDispatches(
			{
				enabled: true,
				readiness,
				reportId: 'report-1',
				revision: 2,
				baseUrl: 'https://hubseo.jonlabs.ch',
				projectAllowlist: ['physiopommier', 'barberconcept']
			},
			{
				loadProjectIds: vi.fn().mockResolvedValue(
					new Map([
						['physiopommier', 'project-1'],
						['barberconcept', 'project-2']
					])
				),
				enqueue
			}
		);

		expect(result).toEqual({ eligible: 2, created: 1, existing: 1, missingProjects: [] });
		expect(enqueue).toHaveBeenCalledTimes(2);
		for (const [job] of enqueue.mock.calls) {
			expect(job.type).toBe('dispatch:seo_weekly');
			expect(job.runId).toBeNull();
			expect(job.priority).toBe(40);
			expect(job.maxAttempts).toBe(8);
			expect(job.payloadJson).not.toMatch(/secret|token|credential/i);
			expect(JSON.parse(job.payloadJson).revision).toBe(2);
		}
	});

	it('respecte la canary allowlist et signale les slugs sans projection SQL', async () => {
		const enqueue = vi.fn().mockResolvedValue({ created: true, id: 'job-1' });
		const result = await queueSeoWeeklyDispatches(
			{
				enabled: true,
				readiness,
				reportId: 'report-1',
				revision: 1,
				baseUrl: 'https://hubseo.jonlabs.ch',
				projectAllowlist: ['physiopommier']
			},
			{
				loadProjectIds: vi.fn().mockResolvedValue(new Map()),
				enqueue
			}
		);
		expect(result).toEqual({
			eligible: 1,
			created: 0,
			existing: 0,
			missingProjects: ['physiopommier']
		});
		expect(enqueue).not.toHaveBeenCalled();
	});
});
