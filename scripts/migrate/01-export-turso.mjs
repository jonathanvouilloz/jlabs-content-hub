// Phase 4a — Export Turso → JSON (lecture seule)
// Dump chaque table Turso + son schéma (PRAGMA) dans OUT_DIR.
// Usage: node scripts/migrate/01-export-turso.mjs
import { createClient } from '@libsql/client';
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';

config({ quiet: true });

const OUT_DIR = process.env.MIGRATE_OUT_DIR;
if (!OUT_DIR) throw new Error('MIGRATE_OUT_DIR requis');
mkdirSync(OUT_DIR, { recursive: true });

const url = process.env.DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN;
if (!url?.startsWith('libsql')) throw new Error(`DATABASE_URL doit être Turso (libsql), reçu: ${url?.split('://')[0]}`);

const db = createClient({ url, authToken });

// Tables applicatives : exclure les tables internes sqlite + la table de migrations drizzle
const skip = new Set(['sqlite_sequence', '__drizzle_migrations', '_litestream_seq', '_litestream_lock']);

const tblRes = await db.execute(
  "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
);
const tables = tblRes.rows.map((r) => r.name).filter((n) => !skip.has(n));

const manifest = { tables: {}, exportedAt: process.env.MIGRATE_STAMP || 'unstamped' };

for (const t of tables) {
  const info = await db.execute(`PRAGMA table_info("${t}")`);
  const cols = info.rows.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
  const data = await db.execute(`SELECT * FROM "${t}"`);
  const rows = data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i]])));
  writeFileSync(`${OUT_DIR}/${t}.json`, JSON.stringify({ columns: cols, rows }, null, 0));
  manifest.tables[t] = { rowCount: rows.length, columns: cols.map((c) => `${c.name}:${c.type}`) };
  console.log(`  ${t.padEnd(28)} ${String(rows.length).padStart(6)} rows  (${cols.length} cols)`);
}

writeFileSync(`${OUT_DIR}/_manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n${tables.length} tables exportées → ${OUT_DIR}`);
