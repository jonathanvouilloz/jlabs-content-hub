import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(resolve(process.cwd(), 'drizzle/manual-data-011.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), 'src/lib/server/db/schema.ts'), 'utf8');
const collector = readFileSync(
	resolve(process.cwd(), 'src/lib/server/collectors/gmb-reviews.ts'),
	'utf8'
);
const agentService = readFileSync(
	resolve(process.cwd(), 'src/lib/server/reviews/agent-review-service.ts'),
	'utf8'
);

describe('DATA-011', () => {
	it('reste additive et rejouable', () => {
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "review_reply_url" text');
		const executable = ddl.replace(/^\s*--.*$/gm, '');
		expect(executable).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i);
	});

	it('aligne migration, schema, collecte et API agent', () => {
		expect(schema).toContain("reviewReplyUrl: text('review_reply_url')");
		expect(collector).toContain('reviewReplyUrl: sql`excluded.review_reply_url`');
		expect(agentService).toContain('googleReviewUrl: review.reviewReplyUrl');
	});
});
