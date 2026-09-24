/**
 * Policy de publication des reponses Google Barber Concept.
 *
 * Source : projets/barberconcept/docs/business/profile.md, gouvernance revalidee le 2026-09-21.
 * Dry-run par defaut. `--apply` rend les avis 4-5 etoiles non sensibles auto-publiables ; cette
 * option a donc un effet externe reel via Hermes et doit rester un geste operateur explicite.
 */
import 'dotenv/config';
import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { and, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { computePolicyHash, promotePolicy } from '../src/lib/server/policies.js';
import type { PolicyConfig } from '../src/lib/server/policy-state.js';

neonConfig.webSocketConstructor = ws;

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const config: PolicyConfig = {
	mode: 'guarded_auto',
	syncEnabled: true,
	autoGenerationEnabled: true,
	killSwitch: false,
	minRatingForAutoSend: 4,
	sendDelayMinutes: 0,
	jitterMinutes: 0,
	defaultLanguage: 'fr-CH',
	signature: "L'équipe Barber Concept",
	escalationCategoriesJson: JSON.stringify(['sensitive']),
	maxSendsPerRun: 20
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

try {
	const project = await db.query.projects.findFirst({
		where: eq(schema.projects.slug, 'barberconcept')
	});
	if (!project) throw new Error('barberconcept project not found');

	const projection = await db.query.projectProjections.findFirst({
		where: and(
			eq(schema.projectProjections.projectId, project.id),
			eq(schema.projectProjections.status, 'current')
		)
	});
	if (!projection) throw new Error('current projection required before policy promotion');

	const current = await db.query.reviewAutomationPolicies.findFirst({
		where: and(
			eq(schema.reviewAutomationPolicies.projectId, project.id),
			eq(schema.reviewAutomationPolicies.scopeKey, '*'),
			eq(schema.reviewAutomationPolicies.status, 'current')
		)
	});
	const policyHash = computePolicyHash(config);
	const summary = {
		mode: apply ? 'apply' : 'dry-run',
		project: project.slug,
		projectionHash: projection.sourceHash,
		policyHash,
		current: current
			? {
				version: current.version,
				mode: current.mode,
				killSwitch: current.killSwitch,
				policyHash: current.policyHash
			}
			: null,
		requested: {
			mode: config.mode,
			minRatingForAutoSend: config.minRatingForAutoSend,
			killSwitch: config.killSwitch,
			maxSendsPerRun: config.maxSendsPerRun
		}
	};

	if (!apply) {
		console.log(JSON.stringify(summary, null, 2));
	} else {
		const result = await promotePolicy(
			{
				projectId: project.id,
				locationId: null,
				config,
				actor: 'codex',
				reason: 'Policy Barber Concept revalidee le 2026-09-21 ; activation Hermes production'
			},
			db
		);
		console.log(JSON.stringify({ ...summary, result }, null, 2));
	}
} finally {
	await pool.end();
}
