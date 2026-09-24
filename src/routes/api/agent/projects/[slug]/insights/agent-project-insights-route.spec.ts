import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GET /api/agent/projects/[slug]/insights', () => {
	it('uses the dedicated read scope, explicit project allowlist and bounded projection', () => {
		const route = readFileSync(
			resolve(process.cwd(), 'src/routes/api/agent/projects/[slug]/insights/+server.ts'),
			'utf8'
		);
		expect(route).toContain("authorizeMachineProject(event, 'agent:insights:read', event.params.slug)");
		expect(route).toContain('buildAgentProjectInsights');
		expect(route).toContain('listSnapshots');
		expect(route).not.toContain('process.env.DATABASE_URL');
	});
});
