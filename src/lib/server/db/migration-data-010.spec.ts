import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(resolve(process.cwd(), 'drizzle/manual-data-010.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), 'src/lib/server/db/schema.ts'), 'utf8');

describe('DATA-010', () => {
	it('reste additive et rejouable', () => {
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS');
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
		const executable = ddl.replace(/^\s*--.*$/gm, '');
		expect(executable).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i);
	});

	it('aligne les trois nouvelles autorites avec le schema Drizzle', () => {
		for (const table of [
			'review_reply_delivery_events',
			'review_mention_candidates',
			'review_monthly_reports'
		]) {
			expect(ddl).toContain(`"${table}"`);
			expect(schema).toContain(`'${table}'`);
		}
	});

	it('contraint les mentions candidates sans notion de prime', () => {
		expect(ddl).toContain('review_mention_candidates_confidence_check');
		expect(ddl).toContain("'candidate', 'validated', 'rejected', 'resolved'");
		const candidateTable = ddl.split('CREATE TABLE IF NOT EXISTS "seostats"."review_mention_candidates"')[1]
			?.split('CREATE TABLE IF NOT EXISTS "seostats"."review_monthly_reports"')[0] ?? '';
		expect(candidateTable).not.toMatch(/bonus|prime/i);
	});
});
