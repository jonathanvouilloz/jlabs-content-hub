import { defineConfig } from 'vitest/config';

// Config vitest minimale (IDX-008) — 1re infra de test du repo.
// Pas de plugin SvelteKit : les tests ciblent des modules PURS (aucun `$env`/db),
// donc le runner reste rapide et isolé du runtime serveur.
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.{ts,js}'],
		environment: 'node'
	}
});
