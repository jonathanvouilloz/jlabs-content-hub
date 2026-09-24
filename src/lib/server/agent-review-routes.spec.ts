import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('API agent avis v1', () => {
	it('borne chaque route au slug du credential et au scope minimal', () => {
		const routes = [
			['src/routes/api/agent/v1/projects/[slug]/reviews/+server.ts', 'review:read'],
			['src/routes/api/agent/v1/projects/[slug]/reviews/[reviewId]/proposals/+server.ts', 'review:propose'],
			['src/routes/api/agent/v1/projects/[slug]/reviews/[reviewId]/mentions/+server.ts', 'review:propose'],
			['src/routes/api/agent/v1/projects/[slug]/proposals/[proposalId]/publish/+server.ts', 'review:publish'],
			['src/routes/api/agent/v1/projects/[slug]/proposals/[proposalId]/reconcile/+server.ts', 'review:publish'],
			['src/routes/api/agent/v1/projects/[slug]/monthly-reports/[period]/+server.ts', 'review:report:read']
		] as const;
		for (const [path, scope] of routes) {
			const source = read(path);
			expect(source).toContain(`authorizeMachineProject(event, '${scope}', event.params.slug)`);
			expect(source).not.toContain('validateApiKey(');
		}
	});

	it('la reconciliation est GET-only et ne dispose d aucun adaptateur PUT', () => {
		const source = read('src/routes/api/agent/v1/projects/[slug]/proposals/[proposalId]/reconcile/+server.ts');
		expect(source).toContain('export const GET');
		expect(source).not.toContain('export const POST');
		expect(source).not.toContain('putReply:');
	});

	it('les mutations exigent une cle d idempotence', () => {
		for (const path of [
			'src/routes/api/agent/v1/projects/[slug]/reviews/[reviewId]/proposals/+server.ts',
			'src/routes/api/agent/v1/projects/[slug]/reviews/[reviewId]/mentions/+server.ts',
			'src/routes/api/agent/v1/projects/[slug]/proposals/[proposalId]/publish/+server.ts'
		]) {
			expect(read(path)).toContain('requireIdempotencyKey(event.request)');
		}
	});
});
