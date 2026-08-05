import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyMachineScopeForRequest } from './api-auth-policy';

function filesBelow(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? filesBelow(path) : [path];
	});
}

describe('frontière serveur des credentials', () => {
	it('ne livre aucun pseudo bearer ni VITE_API_KEY dans les sources navigateur', () => {
		const root = resolve(process.cwd(), 'src');
		const browserFiles = filesBelow(root).filter((path) => path.endsWith('.svelte'));
		for (const path of browserFiles) {
			const source = readFileSync(path, 'utf8');
			expect(source, relative(root, path)).not.toMatch(/dev-api-key|VITE_API_KEY|Authorization\s*:/);
		}
	});

	it('ne sérialise jamais access_token depuis les loaders admin', () => {
		const path = resolve(process.cwd(), 'src/routes/(app)/projects/[slug]/+layout.server.ts');
		const source = readFileSync(path, 'utf8');
		expect(source).toMatch(/columns:\s*\{/);
		expect(source).not.toMatch(/return\s*\{[\s\S]*project\s*,/);
	});

	it('ne fabrique jamais un lien email depuis le vérificateur stocké', () => {
		const path = resolve(process.cwd(), 'src/routes/api/cron/gmb-weekly-digest/+server.ts');
		const source = readFileSync(path, 'utf8');
		expect(source).not.toMatch(/project\.accessToken|token=\$\{project/);
	});
});

describe('politique transitoire des routes validateApiKey', () => {
	it('attribue des scopes explicites et refuse les routes non classées', () => {
		expect(legacyMachineScopeForRequest('GET', '/api/projects/wildcat/gsc/history')).toBe('gsc:read');
		expect(legacyMachineScopeForRequest('POST', '/api/projects/wildcat/gsc/backfill')).toBe('gsc:write');
		expect(legacyMachineScopeForRequest('PATCH', '/api/content/abc/status')).toBe('content:status');
		expect(legacyMachineScopeForRequest('DELETE', '/api/comments/abc')).toBe('comments:write');
		expect(legacyMachineScopeForRequest('GET', '/api/not-classified')).toBeNull();
	});
});