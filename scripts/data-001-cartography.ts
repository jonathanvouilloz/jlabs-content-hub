/**
 * DATA-001 — Introspection read-only du schéma Neon.
 *
 * Se connecte à la DB Neon (DATABASE_URL du .env), interroge `information_schema`
 * + `pg_indexes` + `count(*)` pour produire la cartographie réelle des schémas
 * `seostats` et `core` : tables live, volumes, colonnes, clés (PK/UNIQUE), FK, index.
 * Réconcilie ensuite la DB réelle avec le modèle Drizzle (`schema.ts`) pour révéler
 * toute dérive (base non vide — cf. acceptation DATA-001).
 *
 * 100% READ-ONLY : uniquement des SELECT sur les vues catalogue. Aucune écriture.
 *
 * Lancer :  npx tsx scripts/data-001-cartography.ts
 * Sortie :  console (tableau lisible) + docs/_generated/data-001-introspection.json
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const SCHEMAS = ['seostats', 'core'];

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface ColumnInfo {
	column: string;
	type: string;
	nullable: boolean;
	default: string | null;
}
interface KeyInfo {
	constraint: string;
	columns: string[];
}
interface ForeignKey {
	constraint: string;
	columns: string[];
	refSchema: string;
	refTable: string;
	refColumns: string[];
}
interface TableCarto {
	schema: string;
	table: string;
	rowCount: number;
	columns: ColumnInfo[];
	primaryKey: string[];
	uniques: KeyInfo[];
	foreignKeys: ForeignKey[];
	indexes: string[];
}

async function liveTables(): Promise<Array<{ schema: string; table: string }>> {
	const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
		`SELECT table_schema, table_name
		   FROM information_schema.tables
		  WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'
		  ORDER BY table_schema, table_name`,
		[SCHEMAS]
	);
	return rows.map((r) => ({ schema: r.table_schema, table: r.table_name }));
}

async function rowCount(schema: string, table: string): Promise<number> {
	// Identifiants issus de information_schema (non user-input) → interpolation sûre.
	const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${schema}"."${table}"`);
	return Number(rows[0]?.n ?? 0);
}

async function columns(schema: string, table: string): Promise<ColumnInfo[]> {
	const { rows } = await pool.query<{
		column_name: string;
		data_type: string;
		is_nullable: string;
		column_default: string | null;
	}>(
		`SELECT column_name, data_type, is_nullable, column_default
		   FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2
		  ORDER BY ordinal_position`,
		[schema, table]
	);
	return rows.map((r) => ({
		column: r.column_name,
		type: r.data_type,
		nullable: r.is_nullable === 'YES',
		default: r.column_default
	}));
}

async function keysAndFks(
	schema: string,
	table: string
): Promise<{ primaryKey: string[]; uniques: KeyInfo[]; foreignKeys: ForeignKey[] }> {
	// PK + UNIQUE
	const { rows: tc } = await pool.query<{ constraint_name: string; constraint_type: string; column_name: string }>(
		`SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.key_column_usage kcu
		     ON tc.constraint_name = kcu.constraint_name
		    AND tc.table_schema = kcu.table_schema
		  WHERE tc.table_schema = $1 AND tc.table_name = $2
		    AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
		  ORDER BY tc.constraint_name, kcu.ordinal_position`,
		[schema, table]
	);
	const primaryKey: string[] = [];
	const uniqueMap = new Map<string, string[]>();
	for (const r of tc) {
		if (r.constraint_type === 'PRIMARY KEY') primaryKey.push(r.column_name);
		else {
			const arr = uniqueMap.get(r.constraint_name) ?? [];
			arr.push(r.column_name);
			uniqueMap.set(r.constraint_name, arr);
		}
	}
	const uniques = [...uniqueMap.entries()].map(([constraint, cols]) => ({ constraint, columns: cols }));

	// FK avec cible (schéma.table.colonnes)
	const { rows: fk } = await pool.query<{
		constraint_name: string;
		column_name: string;
		ref_schema: string;
		ref_table: string;
		ref_column: string;
	}>(
		`SELECT tc.constraint_name,
		        kcu.column_name,
		        ccu.table_schema AS ref_schema,
		        ccu.table_name   AS ref_table,
		        ccu.column_name  AS ref_column
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.key_column_usage kcu
		     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		   JOIN information_schema.constraint_column_usage ccu
		     ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
		  WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
		  ORDER BY tc.constraint_name`,
		[schema, table]
	);
	const fkMap = new Map<string, ForeignKey>();
	for (const r of fk) {
		const existing = fkMap.get(r.constraint_name);
		if (existing) {
			existing.columns.push(r.column_name);
			existing.refColumns.push(r.ref_column);
		} else {
			fkMap.set(r.constraint_name, {
				constraint: r.constraint_name,
				columns: [r.column_name],
				refSchema: r.ref_schema,
				refTable: r.ref_table,
				refColumns: [r.ref_column]
			});
		}
	}
	return { primaryKey, uniques, foreignKeys: [...fkMap.values()] };
}

async function indexes(schema: string, table: string): Promise<string[]> {
	const { rows } = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
		[schema, table]
	);
	return rows.map((r) => r.indexname);
}

/** Liste des tables déclarées dans le modèle Drizzle (schema.ts). */
function modelTables(): Set<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const src = readFileSync(join(here, '..', 'src', 'lib', 'server', 'db', 'schema.ts'), 'utf8');
	const set = new Set<string>();
	const re = /\.table\(\s*['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) set.add(m[1]);
	return set;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
	const stamp = process.argv[2] ?? 'unstamped';
	const live = await liveTables();
	const carto: TableCarto[] = [];

	for (const { schema, table } of live) {
		const [rc, cols, keys, idx] = await Promise.all([
			rowCount(schema, table),
			columns(schema, table),
			keysAndFks(schema, table),
			indexes(schema, table)
		]);
		carto.push({
			schema,
			table,
			rowCount: rc,
			columns: cols,
			primaryKey: keys.primaryKey,
			uniques: keys.uniques,
			foreignKeys: keys.foreignKeys,
			indexes: idx
		});
	}

	// Réconciliation modèle Drizzle ↔ DB réelle.
	const model = modelTables();
	const liveNames = new Set(live.map((t) => t.table));
	const inDbNotModel = [...liveNames].filter((t) => !model.has(t)).sort();
	const inModelNotDb = [...model].filter((t) => !liveNames.has(t)).sort();
	const inBoth = [...liveNames].filter((t) => model.has(t)).sort();

	// --- Console lisible ---
	console.log(`\nDATA-001 — cartographie Neon (${stamp})`);
	console.log('─'.repeat(88));
	console.log(`${pad('schema.table', 42)} ${pad('rows', 8)} ${pad('PK/UNIQUE', 20)} FK  IDX`);
	console.log('─'.repeat(88));
	for (const t of carto) {
		const natural = [
			t.primaryKey.length ? `pk(${t.primaryKey.join(',')})` : '',
			...t.uniques.map((u) => `uq(${u.columns.join(',')})`)
		]
			.filter(Boolean)
			.join(' ');
		console.log(
			`${pad(`${t.schema}.${t.table}`, 42)} ${pad(String(t.rowCount), 8)} ${pad(natural.slice(0, 19), 20)} ${pad(String(t.foreignKeys.length), 3)} ${t.indexes.length}`
		);
	}
	console.log('─'.repeat(88));
	console.log(`Tables live: ${live.length} | modèle schema.ts: ${model.size}`);
	console.log(`Dérive — DB sans modèle: [${inDbNotModel.join(', ') || '∅'}]`);
	console.log(`Dérive — modèle sans DB: [${inModelNotDb.join(', ') || '∅'}]`);
	console.log(`Présentes des deux côtés: ${inBoth.length}`);

	// --- Snapshot JSON ---
	const here = dirname(fileURLToPath(import.meta.url));
	const outDir = join(here, '..', 'docs', '_generated');
	mkdirSync(outDir, { recursive: true });
	const outFile = join(outDir, 'data-001-introspection.json');
	writeFileSync(
		outFile,
		JSON.stringify(
			{
				stamp,
				schemas: SCHEMAS,
				summary: {
					liveCount: live.length,
					modelCount: model.size,
					inDbNotModel,
					inModelNotDb,
					inBothCount: inBoth.length
				},
				tables: carto
			},
			null,
			2
		),
		'utf8'
	);
	console.log(`\nJSON écrit → ${outFile}\n`);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Introspection échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
