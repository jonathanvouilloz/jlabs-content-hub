import { createClient } from '@libsql/client';
import { config } from 'dotenv';

config();

const slug = process.argv[2] || 'barberconcept';
const period = process.argv[3] || '2026-04';
const [year, month] = period.split('-').map(Number);

const start = `${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`;
const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
const end = `${nextMonth}T00:00:00Z`;

const client = createClient({
	url: process.env.DATABASE_URL,
	authToken: process.env.DATABASE_AUTH_TOKEN
});

const projectRes = await client.execute({
	sql: 'SELECT id, name FROM projects WHERE slug = ?',
	args: [slug]
});
if (projectRes.rows.length === 0) {
	console.error(`Projet "${slug}" introuvable`);
	process.exit(1);
}
const project = projectRes.rows[0];
console.log(`Projet : ${project.name} (${project.id})`);
console.log(`Période : ${period} (${start} → ${end})`);
console.log('');

const total = await client.execute({
	sql: `SELECT COUNT(*) AS n FROM gmb_reviews
	      WHERE project_id = ? AND create_time >= ? AND create_time < ?`,
	args: [project.id, start, end]
});
console.log(`Total avis sur ${period} : ${total.rows[0].n}`);

const byRating = await client.execute({
	sql: `SELECT rating, COUNT(*) AS n FROM gmb_reviews
	      WHERE project_id = ? AND create_time >= ? AND create_time < ?
	      GROUP BY rating ORDER BY rating DESC`,
	args: [project.id, start, end]
});
console.log('\nRépartition par note :');
for (const row of byRating.rows) {
	console.log(`  ${row.rating}★ : ${row.n}`);
}

const firstLast = await client.execute({
	sql: `SELECT MIN(create_time) AS first, MAX(create_time) AS last FROM gmb_reviews
	      WHERE project_id = ? AND create_time >= ? AND create_time < ?`,
	args: [project.id, start, end]
});
console.log(`\nPremier avis : ${firstLast.rows[0].first}`);
console.log(`Dernier avis : ${firstLast.rows[0].last}`);

const byDay = await client.execute({
	sql: `SELECT substr(create_time, 1, 10) AS day, COUNT(*) AS n FROM gmb_reviews
	      WHERE project_id = ? AND create_time >= ? AND create_time < ?
	      GROUP BY day ORDER BY day ASC`,
	args: [project.id, start, end]
});
console.log(`\nDétail par jour (${byDay.rows.length} jours avec avis) :`);
for (const row of byDay.rows) {
	console.log(`  ${row.day} : ${row.n}`);
}

const allTimeFirst = await client.execute({
	sql: `SELECT MIN(create_time) AS first FROM gmb_reviews WHERE project_id = ?`,
	args: [project.id]
});
console.log(`\nTout premier avis du projet en base : ${allTimeFirst.rows[0].first}`);

const aiReport = await client.execute({
	sql: `SELECT period, generated_at, json_extract(summary_json, '$.reviewCount') AS report_count
	      FROM gmb_ai_reports WHERE project_id = ? AND period = ?`,
	args: [project.id, period]
});
if (aiReport.rows.length > 0) {
	console.log(`\nRapport IA pour ${period} :`);
	console.log(`  Généré le : ${aiReport.rows[0].generated_at}`);
	console.log(`  Nombre d'avis pris en compte : ${aiReport.rows[0].report_count ?? '(champ reviewCount absent)'}`);
} else {
	console.log(`\nAucun rapport IA pour ${period}`);
}

process.exit(0);
