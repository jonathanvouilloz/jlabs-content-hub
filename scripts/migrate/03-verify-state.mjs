// Phase 4 — Vérif d'état : la data Neon est-elle une migration correcte et complète ? (lecture seule)
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const OUT_DIR = process.env.MIGRATE_OUT_DIR;
const sql = neon(process.env.NEON_URL);

// 1) Slugs des projets côté Neon + comparaison Turso
console.log('=== PROJECTS: slugs Neon vs Turso ===');
const neonProj = await sql`select id, slug, name, archived, weekly_digest_enabled from seostats.projects order by slug`;
const tursoProj = JSON.parse(readFileSync(`${OUT_DIR}/projects.json`, 'utf8')).rows;
console.log('Neon :', neonProj.map((p) => p.slug).join(', '));
console.log('Turso:', tursoProj.map((p) => p.slug).sort().join(', '));
console.log('archived types Neon:', neonProj.map((p) => `${p.slug}=${p.archived}(${typeof p.archived})`).join(', '));

// 2) FK projects.slug -> core.entities.slug présente ?
console.log('\n=== FK projects.slug -> core.entities ===');
const fks = await sql`
  select tc.constraint_name, kcu.column_name, ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_col
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
  where tc.constraint_type='FOREIGN KEY' and tc.table_schema='seostats' and tc.table_name='projects'`;
console.log(fks.length ? fks.map((f) => `${f.constraint_name}: ${f.column_name} -> ${f.ref_schema}.${f.ref_table}.${f.ref_col}`).join('\n') : '  ✗ AUCUNE FK sur projects');

// 3) Orphelins : project slug absent de core.entities ?
const orphans = await sql`select slug from seostats.projects p where not exists (select 1 from core.entities e where e.slug=p.slug)`;
console.log('Slugs projets absents de core.entities:', orphans.length ? orphans.map((o) => o.slug).join(', ') : '(aucun) ✓');

// 4) Échantillon de contenu : comparer 3 lignes contents (id, title) Turso vs Neon
console.log('\n=== ÉCHANTILLON contents (intégrité contenu) ===');
const tursoContents = JSON.parse(readFileSync(`${OUT_DIR}/contents.json`, 'utf8')).rows;
const sampleIds = tursoContents.slice(0, 3).map((r) => r.id);
for (const id of sampleIds) {
  const n = await sql`select id, title, status from seostats.contents where id = ${id}`;
  const t = tursoContents.find((r) => r.id === id);
  const match = n.length && n[0].title === t.title ? '✓' : '✗ DIFF';
  console.log(`  ${match} ${id.slice(0, 12)} | turso="${(t.title || '').slice(0, 40)}" neon="${(n[0]?.title || '(absent)').slice(0, 40)}"`);
}

// 5) Timestamp sanity : une ligne user, created_at bien typé date ?
console.log('\n=== TIMESTAMP sanity (user.created_at) ===');
const u = await sql`select email, created_at, email_verified from seostats."user" limit 1`;
console.log(u.length ? `  created_at=${u[0].created_at} (${u[0].created_at instanceof Date ? 'Date ✓' : typeof u[0].created_at}) | email_verified=${u[0].email_verified}(${typeof u[0].email_verified})` : '  (aucun user)');
