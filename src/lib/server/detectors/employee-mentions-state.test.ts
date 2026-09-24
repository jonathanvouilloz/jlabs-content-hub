import { describe, expect, it } from 'vitest';
import { buildUnknownEmployeeMentionFinding, UNKNOWN_EMPLOYEE_MENTION_TYPE } from './employee-mentions-state.js';

describe('unknown employee mention finding state', () => {
	it('uses a stable roster-versioned identity and source-safe evidence', () => {
		const finding = buildUnknownEmployeeMentionFinding({
			projectId: 'p1', reviewId: 'review-1', locationId: 'loc-1', token: 'Sofia', rosterVersion: 'v3'
		});
		expect(finding.type).toBe(UNKNOWN_EMPLOYEE_MENTION_TYPE);
		expect(finding.fingerprint).toContain('v3');
		expect(JSON.stringify(finding.evidence)).not.toMatch(/author|comment/i);
		expect(JSON.stringify(finding.eventPayload)).not.toMatch(/author|comment/i);
	});
});
