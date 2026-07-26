// Phase 5A — Rattrapage des lignes écrites en prod (Turso) et absentes de Neon `seostats`.
//
// Complément de 05-drift-report.mjs, qui dit QUOI manque. Ce script ne fait qu'AJOUTER :
//   - jamais de `delete`, jamais de `truncate` — Neon porte ~30 tables cockpit (jobs, findings,
//     observations, index_selection) dont les FK pointent sur `projects` : un truncate cascaderait.
//   - `on conflict do nothing` SANS cible → couvre la PK *et* tout index unique. C'est ce qui protège
//     `gsc_snapshots` / `gsc_weekly_diffs`, uniques sur (project_id, week_start) : une semaine déjà
//     recollectée par le job cockpit ne se fait pas écraser par la version prod, moins complète.
//   - pré-filtre FK : une ligne dont le parent a justement été sauté par le conflit ci-dessus est
//     écartée et COMPTÉE, au lieu de faire exploser tout le lot sur une violation de FK.
//
// Les conversions de types sont DÉRIVÉES de information_schema (bool / timestamp / json), pas
// écrites à la main : le loader d'origine (Phase 4) vivait en scratchpad et n'existe plus.
//
// Idempotent : rejouable autant de fois que nécessaire, y compris juste après la bascule.
//
// Usage:
//   node scripts/migrate/06-backfill-delta.mjs <table> [table...]
//   node scripts/migrate/06-backfill-delta.mjs --dry-run <table> [table...]

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';

config({ quiet: true });

const ENV_PATH = new URL('../../.env', import.meta.url);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const TABLES = args.filter((a) => !a.startsWith('--'));

if (!TABLES.length) {
	console.error('Usage: node scripts/migrate/06-backfill-delta.mjs [--dry-run] <table> [table...]');
	console.error('Lancer 05-drift-report.mjs pour connaître les tables à passer.');
	process.exit(1);
}

// --- credentials (mêmes conventions que 05-drift-report.mjs) --------------------------------------

function tursoCredsFromEnvFile() {
	let raw;
	try {
		raw = readFileSync(ENV_PATH, 'utf8');
	} catch {
		return {};
	}
	const grab = (key) => raw.match(new RegExp(`^#.*->\\s*${key}=(.+)$`, 'm'))?.[1].trim();
	return { url: grab('DATABASE_URL'), token: grab('DATABASE_AUTH_TOKEN') };
}

const fromFile = tursoCredsFromEnvFile();
const tursoUrl = (process.env.TURSO_URL || fromFile.url || '').trim();
const tursoToken = (process.env.TURSO_AUTH_TOKEN || fromFile.token || '').trim();
if (!tursoUrl.startsWith('libsql://') && !tursoUrl.startsWith('https://')) {
	throw new Error('URL Turso introuvable (.env ligne commentée `-> DATABASE_URL=libsql://...` ou TURSO_URL).');
}
if (!tursoToken) throw new Error('Token Turso introuvable (TURSO_AUTH_TOKEN ou ligne commentée dans .env).');

const neonUrl = (process.env.DATABASE_URL || '').trim();
if (!neonUrl.startsWith('postgresql')) {
	throw new Error(`DATABASE_URL doit être Neon (postgresql), reçu: ${neonUrl.split('://')[0] || '(vide)'}`);
}

const HTTP = tursoUrl.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
const sql = neon(neonUrl);

// --- client HTTP libsql ---------------------------------------------------------------------------

function decode(v) {
	if (!v || v.type === 'null') return null;
	if (v.type === 'integer') return Number(v.value);
	if (v.type === 'float') return v.value;
	return v.value;
}

async function tursoExec(sqls) {
	const res = await fetch(HTTP, {
		method: 'POST',
		headers: { authorization: `Bearer ${tursoToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			requests: [...sqls.map((s) => ({ type: 'execute', stmt: { sql: s } })), { type: 'close' }]
		})
	});
	if (!res.ok) throw new Error(`Turso HTTP ${res.status} ${res.statusText}`);
	const body = await res.json();
	return body.results.slice(0, sqls.length).map((r, i) => {
		if (r.type !== 'ok') throw new Error(`Turso a rejeté la requête #${i}: ${r.error?.message ?? 'erreur inconnue'}`);
		const { cols, rows } = r.response.result;
		return rows.map((row) => Object.fromEntries(cols.map((c, j) => [c.name, decode(row[j])])));
	});
}

// --- schéma cible ------------------------------------------------------------------------------

const colRows = await sql`
	select table_name, column_name, data_type
	from information_schema.columns
	where table_schema = 'seostats'
	order by table_name, ordinal_position`;

/** @type {Record<string, {name: string, type: string}[]>} */
const neonSchema = {};
for (const c of colRows) (neonSchema[c.table_name] ??= []).push({ name: c.column_name, type: c.data_type });

for (const t of TABLES) {
	if (!neonSchema[t]) throw new Error(`Table inconnue dans seostats: ${t}`);
}

// Contraintes FK des tables visées — pour écarter à l'avance les lignes orphelines.
const fkRows = await sql`
	select tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
	from information_schema.table_constraints tc
	join information_schema.key_column_usage kcu
		on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
	join information_schema.constraint_column_usage ccu
		on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
	where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'seostats'`;

/** @type {Record<string, {column: string, refTable: string, refColumn: string}[]>} */
const fks = {};
for (const f of fkRows) {
	(fks[f.table_name] ??= []).push({ column: f.column_name, refTable: f.ref_table, refColumn: f.ref_column });
}

// Index uniques hors PK. `information_schema.table_constraints` ne suffit pas : Drizzle crée ces
// contraintes via `uniqueIndex()`, donc en index, pas en contrainte — elles y seraient invisibles.
const uqRows = await sql`
	select t.relname as table_name, i.relname as index_name, a.attname as column_name, k.ord
	from pg_index x
	join pg_class i on i.oid = x.indexrelid
	join pg_class t on t.oid = x.indrelid
	join pg_namespace n on n.oid = t.relnamespace
	cross join lateral unnest(x.indkey) with ordinality as k(attnum, ord)
	join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
	where n.nspname = 'seostats' and x.indisunique and not x.indisprimary
	order by t.relname, i.relname, k.ord`;

/** @type {Record<string, Record<string, string[]>>} table → index → colonnes */
const uniques = {};
for (const u of uqRows) ((uniques[u.table_name] ??= {})[u.index_name] ??= []).push(u.column_name);

// Ordre de traitement : parents avant enfants, au sein des tables demandées. Sinon insérer
// gsc_query_page_data avant gsc_snapshots écarterait toutes ses lignes pour FK manquante.
function ordered(tables) {
	const set = new Set(tables);
	const out = [];
	const seen = new Set();
	const visit = (t, stack = new Set()) => {
		if (seen.has(t) || stack.has(t)) return; // cycle éventuel : on n'insiste pas
		stack.add(t);
		for (const f of fks[t] ?? []) if (set.has(f.refTable) && f.refTable !== t) visit(f.refTable, stack);
		stack.delete(t);
		seen.add(t);
		out.push(t);
	};
	for (const t of tables) visit(t);
	return out;
}

// --- conversions de types (dérivées, pas codées en dur) --------------------------------------------

function convert(value, type) {
	if (value === null || value === undefined) return null;
	switch (type) {
		case 'boolean':
			return typeof value === 'boolean' ? value : Number(value) !== 0;
		case 'timestamp with time zone':
		case 'timestamp without time zone':
			// Turso stocke soit du texte ISO ('2026-07-24 13:44:48'), soit des epoch ms (tables auth).
			return typeof value === 'number' ? new Date(value) : String(value);
		case 'json':
		case 'jsonb':
			return typeof value === 'string' ? value : JSON.stringify(value);
		case 'integer':
		case 'bigint':
		case 'smallint':
		case 'numeric':
		case 'real':
		case 'double precision':
			return typeof value === 'number' ? value : Number(value);
		default:
			return value;
	}
}

// --- rattrapage ------------------------------------------------------------------------------------

const CHUNK_PARAMS = 5000; // marge large sous la limite de 65535 paramètres de Postgres
const summary = [];
// En dry-run, les parents ne sont pas réellement insérés : sans ça, tout enfant paraîtrait orphelin
// et le dry-run annoncerait 0 ligne là où le run réel en insérerait des milliers.
/** @type {Record<string, object[]>} lignes qu'un run réel aurait insérées, par table déjà traitée */
const planned = {};

for (const table of ordered(TABLES)) {
	const cols = neonSchema[table];
	const names = cols.map((c) => c.name);

	// PK depuis Turso (source de vérité du diff) — composite gérée.
	const [pragma] = await tursoExec([`PRAGMA table_info("${table}")`]);
	const pkCols = pragma
		.filter((c) => c.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((c) => c.name);
	if (!pkCols.length) {
		console.log(`\n### ${table} — SAUTÉE : aucune clé primaire, le diff serait indéterminé.`);
		summary.push({ table, skipped: 'pas de PK' });
		continue;
	}

	const keyOf = (row) => pkCols.map((c) => String(row[c])).join(' ');
	const pkList = pkCols.map((c) => `"${c}"`).join(', ');

	const existing = new Set((await sql(`select ${pkList} from seostats."${table}"`)).map(keyOf));
	const [allRows] = await tursoExec([`select * from "${table}"`]);
	let rows = allRows.filter((r) => !existing.has(keyOf(r)));
	const missing = rows.length;

	console.log(`\n### ${table}`);
	console.log(`  absentes de Neon : ${missing}`);
	if (!missing) {
		planned[table] = [];
		summary.push({ table, missing: 0, inserted: 0 });
		continue;
	}

	// Pré-filtre unicité : une (project_id, week_start) déjà présente côté Neon vient du job cockpit,
	// qui pagine mieux que le cron prod — on garde la version Neon. `on conflict do nothing` le ferait
	// aussi à l'insert, mais on veut le savoir AVANT, pour que le dry-run dise la vérité et que les
	// enfants de ces lignes soient écartés eux aussi.
	let droppedUnique = 0;
	for (const [idxName, idxCols] of Object.entries(uniques[table] ?? {})) {
		if (!idxCols.every((c) => names.includes(c))) continue;
		const list = idxCols.map((c) => `"${c}"`).join(', ');
		const tupleOf = (r) => idxCols.map((c) => String(r[c])).join(' ');
		const taken = new Set((await sql(`select ${list} from seostats."${table}"`)).map(tupleOf));
		const before = rows.length;
		const kept = [];
		for (const r of rows) {
			const k = tupleOf(r);
			if (taken.has(k)) continue; // déjà couvert côté Neon
			taken.add(k); // évite aussi les doublons internes au lot
			kept.push(r);
		}
		rows = kept;
		const lost = before - rows.length;
		if (lost) {
			droppedUnique += lost;
			console.log(`  ⤷ ${lost} ignorée(s) : ${idxName} (${idxCols.join('+')}) déjà pourvu côté Neon`);
		}
	}

	// Pré-filtre FK : écarter (et compter) les lignes dont le parent n'existe pas côté Neon.
	let droppedFk = 0;
	for (const f of fks[table] ?? []) {
		if (!names.includes(f.column)) continue;
		const refs = new Set(
			(await sql(`select distinct "${f.refColumn}" as v from seostats."${f.refTable}"`)).map((r) => String(r.v))
		);
		// Parents traités plus tôt dans ce même run : présents en base si run réel, seulement
		// « prévus » en dry-run — dans les deux cas ils doivent compter comme existants.
		for (const p of planned[f.refTable] ?? []) if (p[f.refColumn] != null) refs.add(String(p[f.refColumn]));
		const before = rows.length;
		rows = rows.filter((r) => r[f.column] === null || r[f.column] === undefined || refs.has(String(r[f.column])));
		const lost = before - rows.length;
		if (lost) {
			droppedFk += lost;
			console.log(`  ⤷ ${lost} écartée(s) : ${f.column} sans parent dans ${f.refTable} (parent lui-même en conflit)`);
		}
	}

	planned[table] = rows;

	if (DRY) {
		console.log(`  [dry-run] ${rows.length} ligne(s) seraient insérées`);
		summary.push({ table, missing, insertable: rows.length, droppedUnique, droppedFk, dry: true });
		continue;
	}

	const colList = names.map((c) => `"${c}"`).join(', ');
	const perChunk = Math.max(1, Math.floor(CHUNK_PARAMS / names.length));
	let inserted = 0;

	for (let i = 0; i < rows.length; i += perChunk) {
		const chunk = rows.slice(i, i + perChunk);
		const params = [];
		const tuples = chunk.map((row) => {
			const ph = cols.map((c) => {
				params.push(convert(row[c.name], c.type));
				return `$${params.length}`;
			});
			return `(${ph.join(', ')})`;
		});
		const res = await sql(
			`insert into seostats."${table}" (${colList}) values ${tuples.join(', ')} on conflict do nothing`,
			params,
			{ fullResults: true }
		);
		inserted += res.rowCount ?? 0;
	}

	// Filet : si le pré-filtre a laissé passer un conflit, `on conflict do nothing` l'absorbe et
	// l'écart apparaît ici plutôt que de faire échouer le lot.
	const residual = rows.length - inserted;
	console.log(`  insérées : ${inserted}${residual ? ` | absorbées par on-conflict : ${residual}` : ''}`);
	summary.push({ table, missing, inserted, droppedUnique, droppedFk, residual });
}

console.log('\n=== RÉSUMÉ ===');
for (const s of summary) console.log(' ', JSON.stringify(s));
if (!DRY) {
	// 03-verify-state.mjs exige un export Turso (MIGRATE_OUT_DIR) qui n'existe plus : le contrôle
	// utile ici est de reconstater le diff, qui doit retomber sur les seules lignes volontairement
	// écartées (doublons de semaine GSC et leurs filles).
	console.log('\nContrôle : node scripts/migrate/05-drift-report.mjs puis ce script en --dry-run (doit annoncer 0 insérable).');
}
