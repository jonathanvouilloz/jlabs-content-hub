/**
 * REP-003 — Publier / lire le rapport du lundi à la main.
 *
 * Le chemin normal est le cron `/api/cron/tick` (JOB-005), qui tente la publication à chaque
 * battement. Ce script existe pour les trois gestes que le cron ne rend pas :
 *
 *   - `--dry-run`  : voir la DÉCISION (publier ? attendre ? pourquoi ?) sans rien écrire ;
 *   - (sans flag)  : publier le créneau courant, à la main (rattrapage après une panne de cron) ;
 *   - `--show`     : imprimer un rapport PUBLIÉ, tel qu'il a été stocké ;
 *   - `--list`     : les derniers créneaux publiés, avec leur SLO ;
 *   - `--revise`   : REGÉNÉRER un créneau publié — ajoute une révision, n'écrase rien (REP-004) ;
 *   - `--diff`     : comparer deux rapports publiés (deux créneaux, ou deux révisions).
 *
 * ⚠️ `--show` n'imprime jamais un rapport reconstruit : le texte est rendu à partir du JSON
 * archivé (`renderWeeklyReportText`), donc ce qu'on lit est exactement ce qui a été publié —
 * contrairement à `rep-001-preview.ts`, qui construit le rapport de l'instant présent.
 *
 * ⚠️ `--revise` EXIGE `--reason` : une révision sans raison est un remplacement silencieux qui
 * a simplement gardé l'ancienne ligne. Le refus est dans le modèle pur ET dans la base
 * (`weekly_reports_revision_reason_check`).
 *
 * Lancer :
 *   npx tsx scripts/rep-003-publish.ts --dry-run
 *   npx tsx scripts/rep-003-publish.ts
 *   npx tsx scripts/rep-003-publish.ts --list
 *   npx tsx scripts/rep-003-publish.ts --show [2026-07-27T09:00] [--revision 1] [--json]
 *   npx tsx scripts/rep-003-publish.ts --revise 2026-07-27T09:00 --reason "collecte terminée" [--dry-run]
 *   npx tsx scripts/rep-003-publish.ts --diff 2026-07-20T09:00 2026-07-27T09:00
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	listPublishedReports,
	listReportRevisions,
	loadPublishedReport,
	publishWeeklyReport,
	reviseWeeklyReport
} from '../src/lib/server/report-publication.js';
import { compareReports, sectionHasChange } from '../src/lib/server/report-history-state.js';
import { renderWeeklyReportText } from '../src/lib/server/weekly-report-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
/** Valeur d'une option `--nom valeur`. */
const option = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const next = args[i + 1];
	return next && !next.startsWith('--') ? next : undefined;
};
/** Arguments positionnels (les créneaux de `--show`, `--revise`, `--diff`). */
const positionals = args.filter((a, i) => {
	if (a.startsWith('--')) return false;
	// La valeur qui suit une option n'est pas un positionnel.
	const prev = args[i - 1];
	return !(prev?.startsWith('--') && ['reason', 'revision'].includes(prev.slice(2)));
});
const positional = positionals[0];

const minutes = (ms: number) => `${Math.round(ms / 60000)} min`;

async function main(): Promise<void> {
	if (flag('list')) {
		const rows = await listPublishedReports({ db, limit: 20 });
		if (rows.length === 0) {
			console.log('Aucun rapport publié.');
			return;
		}
		for (const r of rows) {
			console.log(
				`${r.periodSlot}  ${r.status.padEnd(8)}  SLO ${r.slo.met ? 'tenu ' : 'manqué'}` +
					`  latence ${minutes(r.slo.latencyMs).padStart(8)}` +
					`  rév. ${r.revision}/${r.revisionCount}` +
					`  attendus ${r.readiness?.expected ?? '?'}` +
					`  prêts ${r.readiness?.ready ?? '?'}` +
					`  incidents ${r.readiness?.incidents.length ?? '?'}`
			);
		}
		return;
	}

	// ── REP-004 — réviser un créneau publié ──────────────────────────
	if (flag('revise')) {
		const slot = option('revise') ?? positional;
		if (!slot) {
			console.error('Créneau manquant : --revise 2026-07-27T09:00 --reason "…"');
			process.exitCode = 1;
			return;
		}
		const result = await reviseWeeklyReport({
			db,
			periodSlot: slot,
			reason: option('reason') ?? null,
			dryRun: flag('dry-run')
		});
		console.log(`créneau      : ${result.periodSlot}`);
		console.log(`décision     : ${result.action}${result.dryRun ? ' [dry-run]' : ''}`);
		if (result.note) console.log(`note         : ${result.note}`);
		if (result.action === 'refuse') {
			process.exitCode = 1;
			return;
		}
		console.log(`révision     : ${result.revision} (remplace ${result.supersedesId ?? '—'})`);
		console.log(`statut       : ${result.previousStatus} → ${result.status ?? '—'}`);
		console.log(`écrit à      : ${result.publishedAtDb ?? '—'}`);
		if (result.readiness) {
			console.log(
				`préparation  : attendus ${result.readiness.expected} · prêts ${result.readiness.ready}` +
					` · dégradés ${result.readiness.degraded} · absents ${result.readiness.missing}`
			);
		}
		// L'ORIGINAL reste lisible — c'est l'acceptation, dite à chaque révision.
		const revisions = await listReportRevisions({ db, periodSlot: slot });
		console.log('');
		console.log('lignage (aucune ligne n’a été modifiée) :');
		for (const r of revisions) {
			console.log(
				`  rév. ${r.revision}  ${r.status.padEnd(8)}  écrit ${r.publishedAt}  ${r.revisionReason ?? '(publication automatique)'}`
			);
		}
		return;
	}

	// ── REP-004 — comparer deux rapports publiés ─────────────────────
	if (flag('diff')) {
		const [a, b] = [option('diff') ?? positionals[0], positionals[1] ?? positionals[0]];
		if (!a || !b || a === b) {
			console.error('Deux créneaux attendus : --diff 2026-07-20T09:00 2026-07-27T09:00');
			process.exitCode = 1;
			return;
		}
		const [baseRow, headRow] = await Promise.all([
			loadPublishedReport({ db, periodSlot: a }),
			loadPublishedReport({ db, periodSlot: b })
		]);
		if (!baseRow || !headRow) {
			console.error(`Rapport introuvable : ${!baseRow ? a : b}`);
			process.exitCode = 1;
			return;
		}
		const comparison = compareReports({
			base: {
				periodSlot: baseRow.periodSlot,
				revision: baseRow.revision,
				reportSchemaVersion: baseRow.reportSchemaVersion,
				detail: baseRow.detail
			},
			head: {
				periodSlot: headRow.periodSlot,
				revision: headRow.revision,
				reportSchemaVersion: headRow.reportSchemaVersion,
				detail: headRow.detail
			}
		});
		if (comparison.kind === 'unavailable') {
			console.log(`comparaison indisponible (${comparison.reason}) : ${comparison.note}`);
			return;
		}
		console.log(
			`# ${comparison.base.periodSlot} (rév. ${comparison.base.revision}) → ${comparison.head.periodSlot} (rév. ${comparison.head.revision}) · axe ${comparison.axis}`
		);
		console.log(`# ${comparison.summary.headline}`);
		for (const block of comparison.blocks) console.log(`# ⚠ ${block.note}`);
		const changed = comparison.sections.filter(sectionHasChange);
		for (const s of changed) {
			console.log('');
			console.log(`## ${s.title} [${s.kind}]`);
			if (s.kind !== 'comparable') {
				console.log(`   ${s.note}`);
				continue;
			}
			for (const m of s.metrics) {
				if (m.kind === 'comparable' && (m.delta !== 0 || m.renamed)) {
					console.log(
						`   ${m.headLabel} : ${m.baseDisplay} → ${m.headDisplay} (${m.direction})${m.renamed ? ' [renommée]' : ''}`
					);
				} else if (m.kind === 'appeared') {
					console.log(`   ${m.label} : APPARUE (${m.headDisplay}) — pas une hausse`);
				} else if (m.kind === 'disappeared') {
					console.log(`   ${m.label} : DISPARUE (valait ${m.baseDisplay})`);
				} else if (m.kind !== 'comparable') {
					console.log(`   ${m.label} : ${m.baseDisplay} → ${m.headDisplay} — ${m.note}`);
				}
			}
			if (s.items.kind === 'movements') {
				if (s.items.entered.length > 0) {
					console.log(`   entrés (${s.items.entered.length}) : ${s.items.entered.map((i) => i.label).join(' · ')}`);
				}
				if (s.items.left.length > 0) {
					console.log(`   sortis (${s.items.left.length}) : ${s.items.left.map((i) => i.label).join(' · ')}`);
				}
			} else {
				console.log(`   items non comparés : ${s.items.note}`);
			}
		}
		const unchanged = comparison.sections.length - changed.length;
		if (unchanged > 0) console.log(`\n(${unchanged} section(s) sans changement)`);
		return;
	}

	if (flag('show')) {
		const rawRevision = Number(option('revision'));
		const published = await loadPublishedReport({
			db,
			periodSlot: positional,
			revision: Number.isInteger(rawRevision) && rawRevision > 0 ? rawRevision : undefined
		});
		if (!published) {
			console.log(positional ? `Aucun rapport pour ${positional}.` : 'Aucun rapport publié.');
			return;
		}
		if (flag('json')) {
			console.log(JSON.stringify(published, null, 2));
			return;
		}
		console.log(
			`# ${published.periodSlot} — ${published.status.toUpperCase()} · rév. ${published.revision}/${published.revisionCount}` +
				` · écrit ${published.publishedAt} · échéance ${published.dueAt}` +
				` · SLO ${published.slo.met ? 'tenu' : `manqué de ${minutes(published.slo.lateMs)}`}` +
				` (première publication ${published.firstPublishedAt})`
		);
		if (published.revisionReason) console.log(`# raison de la révision : ${published.revisionReason}`);
		if (published.readiness) {
			console.log(
				`# attendus ${published.readiness.expected} · prêts ${published.readiness.ready}` +
					` · dégradés ${published.readiness.degraded} · en attente ${published.readiness.waiting}` +
					` · absents ${published.readiness.missing}` +
					(published.readiness.paused.length > 0
						? ` · écartés (pause) ${published.readiness.paused.join(', ')}`
						: '')
			);
			for (const incident of published.readiness.incidents) {
				console.log(`#   ⚠ ${incident.projectSlug} — ${incident.detail}`);
			}
		}
		console.log('');
		if (published.detail.kind === 'purged') {
			// REP-004 lot 2 — le détail a été retiré : on donne l'adresse, jamais un rapport vide.
			console.log(`# détail purgé le ${published.detail.purgedAt}`);
			console.log(`# archive : ${published.detail.archiveRef}`);
			console.log(
				`# empreinte attendue : ${published.retention.kind === 'purged' ? published.retention.digest : '∅'}`
			);
			return;
		}
		console.log(renderWeeklyReportText(published.detail.report));
		return;
	}

	const result = await publishWeeklyReport({ db, dryRun: flag('dry-run') });
	console.log(`créneau      : ${result.periodSlot ?? '∅ (cadence hebdo désactivée)'}`);
	console.log(`décision     : ${result.action} (${result.reason})${result.dryRun ? ' [dry-run]' : ''}`);
	console.log(`statut       : ${result.status ?? '—'}`);
	console.log(`échéance     : ${result.dueAtDb ?? '—'}`);
	console.log(`publié à     : ${result.publishedAtDb ?? '—'}`);
	if (result.slo) {
		console.log(
			`SLO          : ${result.slo.met ? 'tenu' : `manqué de ${minutes(result.slo.lateMs)}`} · latence ${minutes(result.slo.latencyMs)}`
		);
	}
	if (result.readiness) {
		console.log(
			`préparation  : attendus ${result.readiness.expected} · prêts ${result.readiness.ready}` +
				` · dégradés ${result.readiness.degraded} · en attente ${result.readiness.waiting}` +
				` · absents ${result.readiness.missing}`
		);
		if (result.readiness.blockers.length > 0) {
			console.log(`bloquants    : ${result.readiness.blockers.join(', ')}`);
		}
		if (result.readiness.paused.length > 0) {
			console.log(`écartés      : ${result.readiness.paused.join(', ')} (pause)`);
		}
	}
	if (result.announcement) {
		console.log('');
		console.log(result.announcement.lines.join('\n'));
	}
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
