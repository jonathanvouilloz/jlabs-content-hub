import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = () => readFileSync(resolve(process.cwd(), 'drizzle/0062_core_entity_link.sql'), 'utf8');

describe('migration 0062 additive et rejouable', () => {
	it('s’exécute dans une transaction et protège les objets déjà créés', () => {
		const source = sql();
		expect(source).toMatch(/^BEGIN;/m);
		expect(source).toMatch(/COMMIT;\s*$/m);
		expect(source).toMatch(/ADD COLUMN IF NOT EXISTS "entity_id"/);
		expect(source).toMatch(/CREATE INDEX IF NOT EXISTS "idx_projects_entity_id"/);
		expect(source).toMatch(/pg_constraint[\s\S]*projects_entity_id_fk/);
	});

	it('interrompt la migration si le backfill laisse un projet orphelin', () => {
		const source = sql();
		expect(source).toMatch(/entity_id" IS NULL[\s\S]*RAISE EXCEPTION/i);
		expect(source.indexOf('RAISE EXCEPTION')).toBeLessThan(source.indexOf('ADD CONSTRAINT'));
	});

	it('garde entity_id nullable pendant la transition additive', () => {
		expect(sql()).not.toMatch(/entity_id[^;]*SET NOT NULL/i);
	});
});
