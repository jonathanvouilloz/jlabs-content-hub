/**
 * DASH-006 lot 2 — Suspendre et reprendre une automatisation, à la main.
 *
 * Les pauses ont **une** porte humaine : `POST /api/ops/automations/pause`, qui exige une
 * session (`locals.user`) — donc l'écran `/automations`. Or la décision qui compte le plus
 * se prend précisément quand cet écran n'est pas joignable : **avant** la mise en production
 * du cockpit, pour que le tout premier tick du cron ne parte pas sur les 9 projets d'un coup.
 * Ce script est cette porte-là, et rien d'autre.
 *
 * Il ne réimplémente RIEN : il appelle `recordPauseDecision`, qui valide la cible, dérive
 * l'état courant et écrit le journal dans une seule transaction. L'idempotence (rejouer un
 * geste n'écrit pas de seconde ligne) et l'append-only viennent de là. Une deuxième
 * implémentation de « est-ce déjà en pause ? » divergerait exactement là où ça coûte cher.
 *
 * DRY-RUN PAR DÉFAUT — comme `limits.ts`, `schedule.ts` et `jobs-purge-test.ts`. Suspendre
 * le monitoring d'un client est une décision d'exploitation : elle se lit avant de s'écrire.
 *
 * Lancer :
 *   npx tsx scripts/pauses.ts                                     # état + journal
 *   npx tsx scripts/pauses.ts --pause-all --reason "…"            # dry-run sur les 9 projets
 *   npx tsx scripts/pauses.ts --pause-all --reason "…" --execute
 *   npx tsx scripts/pauses.ts --pause lecureux --reason "…" --execute
 *   npx tsx scripts/pauses.ts --resume lecureux --reason "…" --execute
 *   npx tsx scripts/pauses.ts --cadence daily --pause-all --reason "…"   # autre cadence
 *
 * ⚠️ La cadence visée par défaut est **`weekly`**, parce que c'est celle qui porte le run de
 * référence (9 entrées de catalogue : collecte, 4 détecteurs, production de propositions).
 * La cadence `daily` (3 entrées) n'est PAS suspendue par `--pause-all` : elle fait expirer
 * les veilles et honore les échéances d'inspection, deux gestes qu'on veut voir tourner même
 * pendant une reprise progressive. La suspendre est un geste explicite (`--cadence daily`).
 *
 * ⚠️ Une pause de cadence empêche `planDueJobs` d'OUVRIR le run du créneau. Elle n'empêche ni
 * le drain de ce qui est déjà en file, ni la publication du rapport hebdo (REP-003) — un
 * parc entièrement en pause publie donc un rapport, et ce rapport dit l'absence.
 *
 * ⚠️ Une raison est exigée dans les DEUX sens, reprise comprise. « Pourquoi le monitoring de
 * ce client a-t-il redémarré le 12 août » est la question qu'on se pose trois semaines plus
 * tard ; une reprise sans motif y répond par un blanc.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { asc, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { projects } from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listPauseJournal, loadPauseStates, recordPauseDecision } from '../src/lib/server/pauses.js';
import {
	catalogFor,
	SCHEDULE_CADENCES,
	type ScheduleCadence
} from '../src/lib/server/schedule-state.js';
import {
	describePauseTarget,
	isScheduleCadence,
	pauseKey,
	type PauseTarget
} from '../src/lib/server/pause-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const PAUSE_ALL = args.includes('--pause-all');

/** Valeur d'une option `--nom valeur`. */
const option = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const REASON = option('reason') ?? '';
const PAUSE_ONE = option('pause');
const RESUME_ONE = option('resume');
const ACTOR = option('actor') ?? 'user:contact@jonlabs.ch';

const rawCadence = option('cadence') ?? 'weekly';
if (!isScheduleCadence(rawCadence)) {
	console.error(`Cadence inconnue « ${rawCadence} » (attendu ${SCHEDULE_CADENCES.join(' | ')}).`);
	process.exit(1);
}
const CADENCE: ScheduleCadence = rawCadence;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** Une décision à prendre, résolue avant toute écriture — donc affichable en dry-run. */
interface Decision {
	slug: string;
	projectId: string;
	target: PauseTarget;
	eventType: 'paused' | 'resumed';
	/** Vrai si la cible est DÉJÀ dans l'état voulu : rien ne sera écrit. */
	alreadyThere: boolean;
}

async function main() {
	const now = new Date();
	const rows = await db
		.select({ id: projects.id, slug: projects.slug, archived: projects.archived })
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(asc(projects.slug));

	const states = await loadPauseStates(db, now);

	// ── État courant ────────────────────────────────────────────────
	console.log(`\nCadence visée : ${CADENCE} (${catalogFor(CADENCE).length} entrées de catalogue)`);
	console.log(`Projets actifs : ${rows.length}\n`);

	const line = (slug: string, target: PauseTarget) => {
		const active = states.get(pauseKey(target));
		if (!active) return `  ${slug.padEnd(16)} actif`;
		const until = active.until ? ` jusqu’au ${active.until}` : ' (sans terme)';
		return `  ${slug.padEnd(16)} EN PAUSE${until} — ${active.reason}`;
	};

	for (const p of rows) {
		console.log(
			line(p.slug, { scope: 'project_cadence', projectId: p.id, cadence: CADENCE, provider: null })
		);
	}

	// Une pause de PROJET couvre toutes ses cadences : ne pas la montrer ici ferait lire
	// « actif » un projet entièrement gelé.
	const projectWide = rows.filter((p) =>
		states.get(pauseKey({ scope: 'project', projectId: p.id, cadence: null, provider: null }))
	);
	if (projectWide.length > 0) {
		console.log(`\n  Pauses de PROJET entier : ${projectWide.map((p) => p.slug).join(', ')}`);
	}

	// ── Décisions demandées ─────────────────────────────────────────
	const wanted: Decision[] = [];
	const build = (
		p: { id: string; slug: string },
		eventType: 'paused' | 'resumed'
	): Decision => {
		const target: PauseTarget = {
			scope: 'project_cadence',
			projectId: p.id,
			cadence: CADENCE,
			provider: null
		};
		const active = Boolean(states.get(pauseKey(target)));
		return {
			slug: p.slug,
			projectId: p.id,
			target,
			eventType,
			alreadyThere: eventType === 'paused' ? active : !active
		};
	};

	if (PAUSE_ALL) {
		for (const p of rows) wanted.push(build(p, 'paused'));
	}
	for (const [slug, eventType] of [
		[PAUSE_ONE, 'paused'],
		[RESUME_ONE, 'resumed']
	] as const) {
		if (!slug) continue;
		const p = rows.find((r) => r.slug === slug);
		if (!p) {
			console.error(`\nProjet inconnu ou archivé : « ${slug} ». Abandon.`);
			await pool.end();
			process.exit(1);
		}
		wanted.push(build(p, eventType));
	}

	if (wanted.length === 0) {
		console.log('\n— Journal (10 dernières décisions) —');
		const journal = await listPauseJournal({ db, limit: 10 });
		if (journal.length === 0) console.log('  (aucune décision enregistrée)');
		for (const e of journal) {
			console.log(
				`  ${e.createdAt}  ${e.eventType.padEnd(7)} ${describePauseTarget(
					{
						scope: e.scope as PauseTarget['scope'],
						projectId: e.projectId,
						cadence: e.cadence as PauseTarget['cadence'],
						provider: e.provider as PauseTarget['provider']
					},
					e.projectSlug
				).padEnd(28)} ${e.actor} — ${e.reason}`
			);
		}
		console.log('\n(lecture seule — --pause-all / --pause <slug> / --resume <slug> pour agir)\n');
		await pool.end();
		return;
	}

	if (!REASON.trim()) {
		console.error('\n--reason est obligatoire, y compris pour une reprise. Abandon.');
		await pool.end();
		process.exit(1);
	}

	console.log(`\nDécisions demandées (acteur : ${ACTOR}) :`);
	for (const d of wanted) {
		console.log(
			`  ${d.eventType === 'paused' ? 'PAUSE ' : 'REPRISE'} ${d.slug.padEnd(16)} ${
				d.alreadyThere ? '→ déjà dans cet état, rien ne sera écrit' : '→ une ligne de journal'
			}`
		);
	}
	console.log(`  raison : « ${REASON.trim()} »`);

	if (!EXECUTE) {
		console.log('\n(dry-run — ajouter --execute pour appliquer)\n');
		await pool.end();
		return;
	}

	let written = 0;
	let idempotent = 0;
	for (const d of wanted) {
		const res = await recordPauseDecision({
			db,
			target: d.target,
			eventType: d.eventType,
			reason: REASON,
			actor: ACTOR,
			now
		});
		if (res.idempotent) idempotent++;
		else written++;
	}

	console.log(`\n${written} décision(s) écrite(s), ${idempotent} sans effet (état déjà atteint).`);
	console.log('Le prochain tick lira cet état — rien à redéployer.\n');
	await pool.end();
}

main().catch(async (err) => {
	console.error(err instanceof Error ? err.message : String(err));
	await pool.end();
	process.exit(1);
});
