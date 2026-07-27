/**
 * REP-004 lot 2 — Archiver le détail d'un rapport, puis le purger. À la main, en trois gestes.
 *
 * Un rapport publié pèse ~28 kio de `payload_json` et ne se régénère PAS : REP-003 l'a construit
 * sur l'état du parc de son créneau, et `loadWeeklyReport` répondrait aujourd'hui avec le parc
 * d'aujourd'hui. La rétention n'est donc acceptable que si le détail existe ailleurs — d'où la
 * séquence, dont l'ordre EST la garantie :
 *
 *   1. `--export`  : écrire le `payload_json` OCTET POUR OCTET dans `.seo-data/` ;
 *   2. `/seo-archive --projet _global` : la note du vault (hors de ce repo, couche skills) ;
 *   3. `--confirm` : RETROUVER la note, en extraire le payload, comparer l'empreinte, marquer ;
 *   4. `--purge`   : retirer le payload des lignes que le plan autorise.
 *
 * ⭐ **L'étape 3 ne croit personne.** Elle ne se contente pas de trouver un fichier au bon nom :
 * elle extrait le JSON embarqué dans la note et le hache. Si le titre d'un finding contenait une
 * clôture de bloc markdown, l'extraction serait tronquée, l'empreinte différerait, et la
 * confirmation serait refusée — donc rien ne serait purgé. Le mode de panne est du bon côté.
 *
 * ⚠️ **DRY-RUN PAR DÉFAUT** (idiome maison : `limits.ts`, `schedule.ts`, `propose.ts`). Purger
 * est le seul geste irréversible du cockpit : il se voit avant de s'appliquer.
 *
 * Lancer :
 *   npx tsx scripts/rep-004-archive.ts                                   # état + plan
 *   npx tsx scripts/rep-004-archive.ts --export [--slot 2026-07-27T09:00] --execute
 *   npx tsx scripts/rep-004-archive.ts --confirm [--vault "C:/…/cerveau"] --execute
 *   npx tsx scripts/rep-004-archive.ts --purge --execute
 *   npx tsx scripts/rep-004-archive.ts --set-weeks 52 --execute   # ou --unset
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	confirmReportArchived,
	listArchivableReports,
	listRetentionCandidates,
	loadDetailRetentionWeeks,
	purgeReportDetails,
	saveDetailRetentionWeeks
} from '../src/lib/server/report-retention.js';
import {
	archiveFileName,
	describeDetailState,
	planDetailPurge,
	MIN_DETAIL_RETENTION_WEEKS
} from '../src/lib/server/report-retention-state.js';
import { dbTimestampToMs } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const next = args[i + 1];
	return next && !next.startsWith('--') ? next : undefined;
};

const execute = flag('execute');
const exportDir = option('dir') ?? '.seo-data';
/**
 * Le vault. ⚠️ `noyau/cerveau`, pas `Desktop/noyau/cerveau` : le vault a migré, et pointer à
 * côté ferait échouer l'étape de confirmation — donc bloquerait toute purge, ce qui est le bon
 * sens de panne mais reste une perte de temps.
 */
const vault = option('vault') ?? process.env.OBSIDIAN_VAULT ?? join(homedir(), 'noyau', 'cerveau');
/** Dossiers du vault où une note d'archive peut vivre (inbox, puis là où `/obsidian-curate` la range). */
const VAULT_DIRS = ['00-Inbox', '20-Knowledge', '10-Projets'];

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const kio = (bytes: number) => `${Math.round(bytes / 1024)} kio`;

// ── Le vault, indexé par empreinte ──────────────────────────────────

function* walkMarkdown(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) yield* walkMarkdown(full);
		else if (entry.toLowerCase().endsWith('.md')) yield full;
	}
}

/**
 * Le PAYLOAD embarqué dans une note du vault, ou `null`.
 *
 * ⚠️ Le bloc contient le `payload_json` sur UNE ligne (c'est ce que `JSON.stringify` produit et
 * ce que l'export écrit). L'extraction prend donc la première ligne non vide après la clôture
 * du bloc ouvrant — jamais un `join` de plusieurs lignes, qui réintroduirait des `\n` absents de
 * l'original et ferait diverger l'empreinte.
 */
function extractEmbeddedPayload(markdown: string): string | null {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim().startsWith('```json'));
	if (start === -1) return null;
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim().startsWith('```')) return null; // bloc vide : rien à vérifier
		if (line.trim().length > 0) return line;
	}
	return null;
}

interface VaultNote {
	path: string;
	relative: string;
	payload: string | null;
}

function indexVault(): Map<string, VaultNote> {
	const byDigest = new Map<string, VaultNote>();
	for (const dir of VAULT_DIRS) {
		for (const file of walkMarkdown(join(vault, dir))) {
			let text: string;
			try {
				text = readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			// Le frontmatter n'est qu'un INDEX : il dit quelle note regarder. La preuve, elle, est
			// l'empreinte du payload embarqué, recalculée ci-dessous.
			const m = /content_hash:\s*"?sha256:([0-9a-f]{64})"?/.exec(text.slice(0, 4096));
			if (!m) continue;
			byDigest.set(m[1], {
				path: file,
				relative: relative(vault, file).split(sep).join('/'),
				payload: extractEmbeddedPayload(text)
			});
		}
	}
	return byDigest;
}

// ── Les commandes ───────────────────────────────────────────────────

async function showStatus(): Promise<void> {
	const weeks = await loadDetailRetentionWeeks(db);
	const candidates = await listRetentionCandidates(db);
	const plan = planDetailPurge({
		candidates,
		retentionWeeks: weeks,
		nowMs: Date.now(),
		parseMs: dbTimestampToMs
	});

	console.log(`vault        : ${vault}`);
	console.log(
		`rétention    : ${weeks === null ? 'désactivée (détail conservé sans limite)' : `${weeks} semaines`}` +
			` — clé system_settings « report.detail_retention_weeks », plancher ${MIN_DETAIL_RETENTION_WEEKS}`
	);
	console.log(`rapports     : ${candidates.length} révision(s) publiée(s)`);
	console.log('');
	for (const c of candidates) {
		console.log(`  ${c.periodSlot} rév.${c.revision} — ${describeDetailState(c.detail)}`);
	}
	console.log('');
	console.log(`plan         : ${plan.headline}`);
	for (const entry of plan.purge) {
		console.log(
			`  PURGE  ${entry.periodSlot} rév.${entry.revision} (${entry.ageDays ?? '?'} j) — ${entry.note}`
		);
	}
	for (const h of plan.hold) {
		console.log(`  garde  ${h.periodSlot} rév.${h.revision} [${h.reason}] — ${h.note}`);
	}
}

async function doExport(): Promise<void> {
	const slot = option('slot');
	const rawRevision = Number(option('revision'));
	const rows = await listArchivableReports({
		db,
		periodSlot: slot,
		revision: Number.isInteger(rawRevision) && rawRevision > 0 ? rawRevision : undefined,
		onlyUnarchived: !flag('all')
	});
	if (rows.length === 0) {
		console.log('Rien à exporter (aucun détail en base non archivé — voir --all).');
		return;
	}
	if (execute && !existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

	for (const row of rows) {
		const name = archiveFileName(row.periodSlot, row.revision);
		const target = join(exportDir, name);
		const digest = sha256(row.payloadJson);
		const mismatch = row.digest !== null && row.digest !== digest;
		console.log(
			`${execute ? '[écrit]  ' : '[dry-run]'} ${target} · ${kio(Buffer.byteLength(row.payloadJson, 'utf8'))} · sha256 ${digest.slice(0, 12)}…` +
				(mismatch ? '  ⚠ EMPREINTE PUBLIÉE DIFFÉRENTE' : '')
		);
		if (mismatch) {
			// L'empreinte publiée ne colle pas au payload relu : quelque chose a réécrit la ligne
			// hors des chemins prévus. On l'exporte quand même (le fichier est la donnée), mais on
			// le DIT — la confirmation, elle, refusera.
			console.log(
				`           publiée ${row.digest?.slice(0, 12)}… · relue ${digest.slice(0, 12)}…`
			);
		}
		// ⚠️ Le fichier est le `payload_json` TEL QUEL, sans en-tête ni indentation : c'est ce qui
		// rend l'empreinte de la base, celle du fichier et celle de la note du vault identiques.
		if (execute) writeFileSync(target, row.payloadJson, 'utf8');
	}

	console.log('');
	console.log(`${rows.length} fichier(s) ${execute ? 'écrits' : 'à écrire'} dans ${exportDir}/`);
	console.log(
		'Puis : python ~/.claude/skills/seo-archive/scripts/cli.py --projet _global --source ' +
			exportDir
	);
	console.log('Puis : npx tsx scripts/rep-004-archive.ts --confirm --execute');
}

async function doConfirm(): Promise<void> {
	const rows = await listArchivableReports({
		db,
		onlyUnarchived: !flag('all')
	});
	if (rows.length === 0) {
		console.log('Aucun détail en attente d’archivage.');
		return;
	}
	const notes = indexVault();
	console.log(`vault indexé : ${notes.size} note(s) portant une empreinte · ${vault}`);

	for (const row of rows) {
		const digest = row.digest ?? sha256(row.payloadJson);
		const note = notes.get(digest);
		if (!note) {
			console.log(
				`  ✗ ${row.periodSlot} rév.${row.revision} — aucune note du vault ne porte ${digest.slice(0, 12)}… (exporter puis /seo-archive)`
			);
			continue;
		}
		// ⭐ La preuve : le payload EMBARQUÉ dans la note, rehashé. Trouver la note ne suffit pas.
		if (note.payload === null) {
			console.log(
				`  ✗ ${row.periodSlot} rév.${row.revision} — « ${note.relative} » ne contient pas le détail (bloc json absent ou vide)`
			);
			continue;
		}
		const embedded = sha256(note.payload);
		if (embedded !== digest) {
			console.log(
				`  ✗ ${row.periodSlot} rév.${row.revision} — « ${note.relative} » : détail embarqué non conforme (${embedded.slice(0, 12)}… ≠ ${digest.slice(0, 12)}…)`
			);
			continue;
		}
		if (!execute) {
			console.log(
				`  [dry-run] ${row.periodSlot} rév.${row.revision} — vérifié dans « ${note.relative} »`
			);
			continue;
		}
		const result = await confirmReportArchived({
			db,
			periodSlot: row.periodSlot,
			revision: row.revision,
			fileDigest: embedded,
			archiveRef: note.relative,
			force: flag('all')
		});
		if (result.action === 'confirmed') {
			console.log(`  ✓ ${row.periodSlot} rév.${row.revision} — archivé : ${result.archiveRef}`);
		} else if (result.action === 'already_archived') {
			console.log(
				`  = ${row.periodSlot} rév.${row.revision} — déjà archivé : ${result.archiveRef}`
			);
		} else {
			console.log(`  ✗ ${row.periodSlot} rév.${row.revision} — ${result.note}`);
		}
	}
}

async function doPurge(): Promise<void> {
	const weeks = await loadDetailRetentionWeeks(db);
	const candidates = await listRetentionCandidates(db);
	const plan = planDetailPurge({
		candidates,
		retentionWeeks: weeks,
		nowMs: Date.now(),
		parseMs: dbTimestampToMs
	});
	console.log(plan.headline);
	for (const entry of plan.purge) {
		console.log(`  ${entry.periodSlot} rév.${entry.revision} — ${entry.note}`);
	}
	if (plan.purge.length === 0) {
		// Une purge qui ne purge rien doit dire POURQUOI : « rien à faire » et « tout est retenu
		// pour une raison » ne demandent pas le même geste.
		const reasons = new Map<string, number>();
		for (const h of plan.hold) reasons.set(h.reason, (reasons.get(h.reason) ?? 0) + 1);
		for (const [reason, n] of reasons) console.log(`  garde ${n} × ${reason}`);
		return;
	}
	const outcome = await purgeReportDetails({ db, plan, dryRun: !execute });
	console.log('');
	console.log(
		outcome.dryRun
			? `[dry-run] ${plan.purge.length} détail(s) seraient purgés (~${kio(plan.bytes)}${plan.bytesKnown ? '' : ' au moins'}). Relancer avec --execute.`
			: `${outcome.purged} détail(s) purgés · ${outcome.skipped} ignoré(s) à l’écriture · ${kio(outcome.bytesFreed)} libérés.`
	);
}

async function doSetWeeks(): Promise<void> {
	const unset = flag('unset');
	const raw = option('set-weeks');
	const weeks = unset ? null : Number(raw);
	if (!unset && (!Number.isFinite(weeks as number) || (weeks as number) <= 0)) {
		console.error(`Valeur illisible : --set-weeks ${raw ?? '∅'} (entier > 0, ou --unset).`);
		process.exitCode = 1;
		return;
	}
	const applied = unset ? null : Math.max(MIN_DETAIL_RETENTION_WEEKS, Math.floor(weeks as number));
	if (applied !== null && applied !== weeks) {
		console.log(
			`⚠ ${weeks} semaine(s) demandée(s) → ${applied} appliquée(s) (plancher ${MIN_DETAIL_RETENTION_WEEKS}).`
		);
	}
	if (!execute) {
		console.log(
			`[dry-run] fenêtre de rétention → ${applied === null ? 'désactivée' : `${applied} semaines`}. Relancer avec --execute.`
		);
		return;
	}
	await saveDetailRetentionWeeks({ db, weeks: applied });
	console.log(
		`fenêtre de rétention → ${applied === null ? 'désactivée (conservation sans limite)' : `${applied} semaines`}.`
	);
}

async function main(): Promise<void> {
	if (flag('export')) return doExport();
	if (flag('confirm')) return doConfirm();
	if (flag('purge')) return doPurge();
	if (flag('set-weeks') || flag('unset')) return doSetWeeks();
	return showStatus();
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
