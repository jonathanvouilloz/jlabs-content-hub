import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GET /api/agent/reports/[slot]/projects/[slug]', () => {
	const route = readFileSync(
		resolve(process.cwd(), 'src/routes/api/agent/reports/[slot]/projects/[slug]/+server.ts'),
		'utf8'
	);

	it('borne la lecture au slug déclaré par le credential, pas au seul scope', () => {
		expect(route).toContain("authorizeMachineProject(event, 'monitor:read', event.params.slug)");
		// La forme non bornée laissait un credential `monitor:read` lire le snapshot de
		// n'importe quel projet : c'est elle que ce test interdit de revenir.
		expect(route).not.toMatch(/authorizeMachine\(event/);
	});

	it("n'ouvre aucun accès SQL ni ne reconstruit le rapport", () => {
		expect(route).not.toContain('process.env.DATABASE_URL');
		expect(route).toContain('loadPublishedReport');
		expect(route).toContain('buildProjectWeeklySnapshot');
	});
});
