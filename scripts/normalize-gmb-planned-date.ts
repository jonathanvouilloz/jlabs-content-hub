import 'dotenv/config';
import { createClient } from '@libsql/client';

const dryRun = process.argv.includes('--dry-run');

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN!
});

const rows = await client.execute({
  sql: `SELECT c.id, p.slug, c.title, c.planned_date, c.status
        FROM contents c
        INNER JOIN projects p ON p.id = c.project_id
        WHERE c.type = 'gmb'
          AND c.status IN ('approved','review','draft')
          AND c.planned_date IS NOT NULL
          AND substr(c.planned_date, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND c.planned_date != substr(c.planned_date, 1, 10) || 'T09:00:00'`,
  args: []
});

console.log(`${dryRun ? '[DRY RUN] ' : ''}${rows.rows.length} posts à normaliser :\n`);

const nowIso = new Date().toISOString();
let updated = 0;

for (const row of rows.rows) {
  const id = row.id as string;
  const slug = row.slug as string;
  const title = (row.title as string).slice(0, 50);
  const oldDate = row.planned_date as string;
  const datePart = oldDate.slice(0, 10);
  const newDate = `${datePart}T09:00:00`;

  console.log(`  ${slug.padEnd(15)} ${oldDate.padEnd(24)} → ${newDate}  | ${title}`);

  if (!dryRun) {
    await client.execute({
      sql: `UPDATE contents SET planned_date = ?, updated_at = ? WHERE id = ?`,
      args: [newDate, nowIso, id]
    });
    updated++;
  }
}

console.log(
  `\n${dryRun ? '[DRY RUN] aucun changement appliqué' : `✓ ${updated} posts mis à jour`}`
);
