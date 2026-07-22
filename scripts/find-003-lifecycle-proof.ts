/**
 * FIND-003 — Preuve du cycle de vie sur une VRAIE base (les 3 acceptations).
 *
 * Ce test ne peut pas vivre dans vitest : ce qu'on vérifie ici, c'est le
 * comportement transactionnel de Postgres (upsert sur l'unique fingerprint,
 * incréments atomiques, journal append-only), pas notre arithmétique — celle-ci
 * est déjà couverte par `finding-state.test.ts`.
 *
 * Protocole (tout se passe sur des findings marqués `__test_find003:` — le script
 * ne lit ni ne modifie AUCUN finding réel) :
 *   1. un problème persistant redétecté → UNE seule ligne, occurrence_count 2   [acceptation 1]
 *   2. absences consécutives → auto-résolution au seuil, jamais avant           [FIND-003]
 *   3. récidive après résolution → `reopened`, reopen_count 1, journal complet   [acceptation 2]
 *   4. veille échue → réveillée en `open` avec un événement `unsnoozed`         [acceptation 3]
 *   5. veille NON échue → ni réveillée par le temps, ni rompue par une re-détection
 *   6. dismiss → tient à vie malgré la re-détection (décision produit)
 *   7. transition illégale refusée (le graphe §10.1 est gardé à l'écriture)
 *   8. SUPPRIME exactement les lignes qu'il a créées (aucune autre).
 *
 * Lancer : npx tsx scripts/find-003-lifecycle-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	upsertFinding,
	reconcileDetectionRun,
	snoozeFinding,
	dismissFinding,
	expireSnoozes,
	transitionFinding
} from '../src/lib/server/findings.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp, toDbTimestampPlus } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/** Marqueur exclusif de ce test : aucun finding réel ne porte ce type. */
const TEST_TYPE = '__test_find003';
const RUN_KEY = createId();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

async function pickProjectId(): Promise<string> {
	const rows = await db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base : impossible de créer un finding.');
	return rows[0].id;
}

/** Fingerprint de test, préfixé par la clé de run → isolation totale. */
const fp = (name: string) => `${TEST_TYPE}${'\x1f'}${RUN_KEY}${'\x1f'}${name}`;

async function seed(projectId: string, name: string, severity = 'medium') {
	return upsertFinding(
		{
			projectId,
			type: TEST_TYPE,
			entityType: 'query',
			entityKey: name,
			fingerprint: fp(name),
			title: `[test] ${name}`,
			severity,
			priorityScore: 50,
			confidenceScore: 60,
			detectorVersion: `${TEST_TYPE}@1`
		},
		db
	);
}

async function readFinding(id: string) {
	const rows = await db
		.select({
			id: schema.findings.id,
			status: schema.findings.status,
			occurrenceCount: schema.findings.occurrenceCount,
			consecutiveMisses: schema.findings.consecutiveMisses,
			reopenCount: schema.findings.reopenCount,
			snoozedUntil: schema.findings.snoozedUntil,
			snoozeReason: schema.findings.snoozeReason,
			dismissalCategory: schema.findings.dismissalCategory,
			resolvedAt: schema.findings.resolvedAt,
			resolutionReason: schema.findings.resolutionReason
		})
		.from(schema.findings)
		.where(eq(schema.findings.id, id));
	return rows[0];
}

async function eventTypes(findingId: string): Promise<string[]> {
	const rows = await db
		.select({ eventType: schema.findingEvents.eventType, createdAt: schema.findingEvents.createdAt })
		.from(schema.findingEvents)
		.where(eq(schema.findingEvents.findingId, findingId));
	return rows.map((r) => r.eventType);
}

/** Réconcilie avec une closure donnée (les noms deviennent des fingerprints). */
function reconcile(projectId: string, present: string[], config?: { autoResolveAfterMisses: number }) {
	return reconcileDetectionRun(
		{
			projectId,
			type: TEST_TYPE,
			closure: new Set(present.map(fp)),
			detectorVersion: `${TEST_TYPE}@1`,
			config
		},
		db
	);
}

async function cleanup(): Promise<{ events: number; findings: number }> {
	// Les événements référencent les findings (FK) : ordre imposé.
	const ev = await db.execute(sql`
		DELETE FROM "seostats"."finding_events"
		 WHERE finding_id IN (
		   SELECT id FROM "seostats"."findings"
		    WHERE type = ${TEST_TYPE} AND fingerprint LIKE ${`%${RUN_KEY}%`}
		 ) RETURNING id
	`);
	const fi = await db.execute(sql`
		DELETE FROM "seostats"."findings"
		 WHERE type = ${TEST_TYPE} AND fingerprint LIKE ${`%${RUN_KEY}%`}
		 RETURNING id
	`);
	return { events: ev.rows?.length ?? 0, findings: fi.rows?.length ?? 0 };
}

async function main() {
	console.log(`\n=== FIND-003 — cycle de vie des findings (run ${RUN_KEY}) ===\n`);
	const projectId = await pickProjectId();

	try {
		// ── 1. Un problème persistant n'apparaît qu'une fois ───────────
		console.log('1. Persistance (acceptation 1) :');
		const first = await seed(projectId, 'persistant');
		const second = await seed(projectId, 'persistant');
		check('deux détections → un seul finding', first.id === second.id, `id ${first.id}`);
		check('occurrence_count incrémenté', second.occurrenceCount === 2, `= ${second.occurrenceCount}`);
		check('la 1re détection est marquée neuve, pas la 2de', first.isNew && !second.isNew);
		const persistantRow = await readFinding(first.id);
		check('reste `open` tant qu’il matche', persistantRow.status === 'open', persistantRow.status);

		// ── 2. Auto-résolution : confirmée, jamais sur une seule absence ─
		console.log('\n2. Auto-résolution (confirmation multi-fenêtres) :');
		const fading = await seed(projectId, 'disparait');
		const r1 = await reconcile(projectId, ['persistant']); // 'disparait' absent, 1re fois
		check('1re absence ne résout pas — elle compte', r1.autoResolved === 0 && r1.missed === 1);
		let fadingRow = await readFinding(fading.id);
		check(
			'compteur d’absences à 1, statut inchangé',
			fadingRow.consecutiveMisses === 1 && fadingRow.status === 'open',
			`misses=${fadingRow.consecutiveMisses} status=${fadingRow.status}`
		);

		const r2 = await reconcile(projectId, ['persistant']); // 2e absence → seuil
		check('2e absence consécutive → auto-résolution', r2.autoResolved === 1, `${r2.autoResolved}`);
		fadingRow = await readFinding(fading.id);
		check('statut `resolved`', fadingRow.status === 'resolved', fadingRow.status);
		check('resolved_at et cause posés', !!fadingRow.resolvedAt && !!fadingRow.resolutionReason);
		check('le finding qui matche toujours n’est pas touché', r2.reopened === 0);
		const stillOpen = await readFinding(first.id);
		check(
			'`persistant` toujours ouvert, compteur à zéro',
			stillOpen.status === 'open' && stillOpen.consecutiveMisses === 0
		);

		// ── 3. Récidive → réouverture (acceptation 2) ──────────────────
		console.log('\n3. Récidive (acceptation 2) :');
		await seed(projectId, 'disparait'); // le signal revient
		const r3 = await reconcile(projectId, ['persistant', 'disparait']);
		check('récidive → 1 réouverture', r3.reopened === 1, `${r3.reopened}`);
		fadingRow = await readFinding(fading.id);
		check('statut `reopened`', fadingRow.status === 'reopened', fadingRow.status);
		check('reopen_count incrémenté', fadingRow.reopenCount === 1, `= ${fadingRow.reopenCount}`);
		check(
			'resolved_at / cause effacés à la réouverture',
			fadingRow.resolvedAt === null && fadingRow.resolutionReason === null
		);
		check('compteur d’absences remis à zéro', fadingRow.consecutiveMisses === 0);
		const evs = await eventTypes(fading.id);
		check(
			'journal complet : resolved puis reopened',
			evs.includes('resolved') && evs.includes('reopened'),
			evs.join(', ')
		);

		// ── 4. La veille expire seule (acceptation 3) ──────────────────
		console.log('\n4. Veille (acceptation 3) :');
		const napping = await seed(projectId, 'endormi');
		// Échéance dans le passé : la veille est déjà due.
		await snoozeFinding(
			{
				findingId: napping.id,
				projectId,
				reason: 'test — veille échue',
				until: toDbTimestampPlus(-60_000, new Date())
			},
			db
		);
		let nappingRow = await readFinding(napping.id);
		check('mise en veille : statut + échéance + cause', nappingRow.status === 'snoozed' && !!nappingRow.snoozedUntil && !!nappingRow.snoozeReason);

		const expired = await expireSnoozes({ projectId }, db);
		check('la veille échue est réveillée', expired.reopened.includes(napping.id));
		nappingRow = await readFinding(napping.id);
		check('retour en `open`', nappingRow.status === 'open', nappingRow.status);
		check(
			'échéance et cause effacées',
			nappingRow.snoozedUntil === null && nappingRow.snoozeReason === null
		);
		check('événement `unsnoozed` journalisé', (await eventTypes(napping.id)).includes('unsnoozed'));

		// ── 5. Une veille en cours tient (décision produit) ────────────
		console.log('\n5. Le snooze tient (décision produit) :');
		const sleeping = await seed(projectId, 'dort-encore');
		await snoozeFinding(
			{ findingId: sleeping.id, projectId, reason: 'test — veille en cours', days: 14 },
			db
		);
		const notExpired = await expireSnoozes({ projectId }, db);
		check('veille non échue → pas réveillée', !notExpired.reopened.includes(sleeping.id));
		// Re-détection AVEC aggravation pendant la veille.
		await seed(projectId, 'dort-encore', 'critical');
		const r5 = await reconcile(projectId, ['dort-encore']);
		check('une re-détection ne rompt pas la veille', r5.held >= 1, `held=${r5.held}`);
		const sleepingRow = await readFinding(sleeping.id);
		check('toujours `snoozed` malgré l’aggravation', sleepingRow.status === 'snoozed', sleepingRow.status);
		check('occurrence_count monte quand même', sleepingRow.occurrenceCount === 2);

		// ── 6. Le dismiss vaut à vie (décision produit) ────────────────
		console.log('\n6. Le dismiss tient à vie (décision produit) :');
		const rejected = await seed(projectId, 'faux-positif');
		await dismissFinding(
			{ findingId: rejected.id, projectId, reason: 'test — faux positif', category: 'false_positive' },
			db
		);
		await seed(projectId, 'faux-positif'); // le détecteur le revoit
		await reconcile(projectId, ['faux-positif']);
		const rejectedRow = await readFinding(rejected.id);
		check('reste `dismissed` après re-détection', rejectedRow.status === 'dismissed', rejectedRow.status);
		check('catégorie conservée', rejectedRow.dismissalCategory === 'false_positive');
		check('occurrence_count monte (mesure des faux positifs)', rejectedRow.occurrenceCount === 2);
		const r6 = await reconcile(projectId, []); // absent : ne doit pas être « auto-résolu »
		const rejectedAfter = await readFinding(rejected.id);
		check('une absence ne réécrit pas la décision humaine', rejectedAfter.status === 'dismissed');
		check('… et ne compte pas comme auto-résolution', r6.autoResolved <= 1, `${r6.autoResolved}`);

		// ── 7. Le graphe §10.1 est gardé à l'écriture ──────────────────
		console.log('\n7. Légalité des transitions (§10.1) :');
		let refused = false;
		try {
			await transitionFinding(
				{
					findingId: rejected.id, // dismissed → snoozed : illégal
					projectId,
					toStatus: 'snoozed',
					reason: 'test — transition illégale',
					actor: 'system'
				},
				db
			);
		} catch {
			refused = true;
		}
		check('dismissed → snoozed refusé', refused);
		const untouched = await readFinding(rejected.id);
		check('le statut n’a pas bougé', untouched.status === 'dismissed', untouched.status);

		// ── 8. Aucune fuite : le format DB est respecté ────────────────
		console.log('\n8. Hygiène :');
		const iso = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."findings"
			 WHERE type = ${TEST_TYPE} AND fingerprint LIKE ${`%${RUN_KEY}%`}
			   AND (snoozed_until LIKE '%T%' OR updated_at LIKE '%T%')
		`);
		const isoCount = Number((iso.rows?.[0] as { n: number } | undefined)?.n ?? 0);
		check('aucun horodatage au format ISO (piège lexical)', isoCount === 0, `${isoCount} ligne(s)`);
		console.log(`  (référence temporelle du run : ${toDbTimestamp()})`);
	} finally {
		const removed = await cleanup();
		console.log(
			`\nNettoyage : ${removed.findings} finding(s) et ${removed.events} événement(s) de test supprimés.`
		);
	}

	console.log(
		failures === 0
			? '\n✅ FIND-003 — toutes les vérifications passent.\n'
			: `\n❌ ${failures} vérification(s) en échec.\n`
	);
	await pool.end();
	if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
	console.error('Preuve FIND-003 échouée:', err);
	await cleanup().catch(() => {});
	await pool.end().catch(() => {});
	process.exit(1);
});
