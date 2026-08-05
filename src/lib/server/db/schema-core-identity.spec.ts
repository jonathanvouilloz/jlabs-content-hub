import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { entities, projects } from './schema';

describe('liaison SEO vers l’identité core stable', () => {
	it('garde le slug et ajoute entity_id sans donner core à Drizzle Kit', () => {
		const entityConfig = getTableConfig(entities);
		const projectConfig = getTableConfig(projects);
		const columns = Object.fromEntries(projectConfig.columns.map((column) => [column.name, column]));
		const migration = readFileSync(
			resolve(process.cwd(), 'drizzle/0062_core_entity_link.sql'),
			'utf8'
		);
		const drizzleConfig = readFileSync(resolve(process.cwd(), 'drizzle.config.ts'), 'utf8');

		expect(entityConfig.columns.some((column) => column.name === 'id')).toBe(true);
		expect(columns.slug).toBeDefined();
		expect(columns.entity_id).toBeDefined();
		expect(migration).toMatch(/ADD COLUMN(?: IF NOT EXISTS)? "entity_id" uuid/);
		expect(migration).toMatch(/REFERENCES\s+"core"\."entities"\s*\("id"\)/i);
		expect(migration).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
		expect(migration).not.toMatch(/ALTER TABLE\s+"(core|invoices|onboarding)"\./i);
		expect(drizzleConfig).toContain("schemaFilter: ['seostats']");
	});
});
