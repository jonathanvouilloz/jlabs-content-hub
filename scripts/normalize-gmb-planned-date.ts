import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const dryRun = process.argv.includes('--dry-run');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const rows = await pool.query(
	`SELECT c.id, p.slug, c.title, c.planned_date, c.status
        FROM seostats.contents c
        INNER JOIN seostats.projects p ON p.id = c.project_id
        WHERE c.type = 'gmb'
          AND c.status IN ('approved','review','draft')
          AND c.planned_date IS NOT NULL
          AND substring(c.planned_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND c.planned_date != substring(c.planned_date, 1, 10) || 'T09:00:00'`
);

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
		await pool.query(`UPDATE seostats.contents SET planned_date = $1, updated_at = $2 WHERE id = $3`, [
			newDate,
			nowIso,
			id
		]);
		updated++;
	}
}

console.log(`\n${dryRun ? '[DRY RUN] aucun changement appliqué' : `✓ ${updated} posts mis à jour`}`);

await pool.end();
