// Phase 4b — Réconciliation Turso (manifest+dumps) ↔ Neon seostats (lecture seule)
// Compare l'ensemble des tables + colonnes, liste les types PG spéciaux (bool/timestamp/jsonb),
// et signale les diffs. Usage: NEON_URL=... MIGRATE_OUT_DIR=... node scripts/migrate/02-reconcile.mjs
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const OUT_DIR = process.env.MIGRATE_OUT_DIR;
const sql = neon(process.env.NEON_URL);

const manifest = JSON.parse(readFileSync(`${OUT_DIR}/_manifest.json`, 'utf8'));
const tursoTables = Object.keys(manifest.tables).sort();

const neonCols = await sql`
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'seostats'
  order by table_name, ordinal_position`;

const neonByTable = {};
for (const c of neonCols) (neonByTable[c.table_name] ??= []).push(c);
const neonTables = Object.keys(neonByTable).sort();

const onlyTurso = tursoTables.filter((t) => !neonTables.includes(t));
const onlyNeon = neonTables.filter((t) => !tursoTables.includes(t));

console.log('=== ENSEMBLE DE TABLES ===');
console.log('Turso:', tursoTables.length, '| Neon:', neonTables.length);
console.log('Seulement Turso:', onlyTurso.join(', ') || '(aucune)');
console.log('Seulement Neon :', onlyNeon.join(', ') || '(aucune)');

console.log('\n=== DIFF COLONNES (nom présent d\'un côté seulement) ===');
let colDiffs = 0;
for (const t of tursoTables.filter((t) => neonTables.includes(t))) {
  const tursoCols = manifest.tables[t].columns.map((c) => c.split(':')[0]);
  const nCols = neonByTable[t].map((c) => c.column_name);
  const missingInNeon = tursoCols.filter((c) => !nCols.includes(c));
  const extraInNeon = nCols.filter((c) => !tursoCols.includes(c));
  if (missingInNeon.length || extraInNeon.length) {
    colDiffs++;
    console.log(`  ${t}: manque Neon [${missingInNeon.join(',')}] | extra Neon [${extraInNeon.join(',')}]`);
  }
}
if (!colDiffs) console.log('  (aucun diff de colonnes)');

console.log('\n=== TYPES PG SPÉCIAUX à transformer (bool / timestamp / json) ===');
for (const t of neonTables) {
  const special = neonByTable[t].filter((c) => /bool|timestamp|json/.test(c.data_type));
  if (special.length) console.log(`  ${t}: ${special.map((c) => c.column_name + '=' + c.data_type).join(', ')}`);
}

console.log('\n=== COUNTS actuels Neon (doit être 0 partout) ===');
const nonEmpty = [];
for (const t of neonTables) {
  const r = await sql(`select count(*)::int as n from seostats."${t}"`);
  if (r[0].n > 0) nonEmpty.push(`${t}=${r[0].n}`);
}
console.log(nonEmpty.length ? '  NON VIDE: ' + nonEmpty.join(', ') : '  ✓ toutes vides');
