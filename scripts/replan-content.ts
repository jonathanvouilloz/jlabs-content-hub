import 'dotenv/config';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { contents, projects, statusHistory } from '../src/lib/server/db/schema.js';
import { randomBytes } from 'node:crypto';

const client = createClient({
	url: process.env.DATABASE_URL!,
	authToken: process.env.DATABASE_AUTH_TOKEN
});
const db = drizzle(client);

function createId(): string {
	return randomBytes(12).toString('hex');
}

// ── Schedule config ────────────────────────────────────────────────
// Start: April 6, 2026 (Monday)
// GMB: Monday (1), Wednesday (3), Friday (5)
// Articles: Tuesday (2), Thursday (4)

const START_DATE = new Date('2026-04-06');
const GMB_DAYS = [1, 3, 5]; // Mon, Wed, Fri
const ARTICLE_DAYS = [2, 4]; // Tue, Thu

function getNextSlots(type: 'gmb' | 'article', count: number): string[] {
	const days = type === 'gmb' ? GMB_DAYS : ARTICLE_DAYS;
	const slots: string[] = [];
	const d = new Date(START_DATE);

	while (slots.length < count) {
		const dow = d.getDay(); // 0=Sun, 1=Mon...
		if (days.includes(dow)) {
			const yyyy = d.getFullYear();
			const mm = String(d.getMonth() + 1).padStart(2, '0');
			const dd = String(d.getDate()).padStart(2, '0');
			slots.push(`${yyyy}-${mm}-${dd}`);
		}
		d.setDate(d.getDate() + 1);
	}

	return slots;
}

async function main() {
	console.log('=== Replanification contenu ===\n');

	// Get all contents grouped by project
	const allContents = await db.select().from(contents);
	const allProjects = await db.select().from(projects);
	const projectMap = new Map(allProjects.map((p) => [p.id, p.slug]));

	for (const project of allProjects) {
		const projectContents = allContents.filter((c) => c.projectId === project.id);
		const articles = projectContents.filter((c) => c.type === 'article');
		const gmbs = projectContents.filter((c) => c.type === 'gmb');

		console.log(`\n--- ${project.name} (${project.slug}) ---`);
		console.log(`  Articles: ${articles.length}, GMB: ${gmbs.length}`);

		// Get date slots
		const articleSlots = getNextSlots('article', articles.length);
		const gmbSlots = getNextSlots('gmb', gmbs.length);

		// Update articles
		for (let i = 0; i < articles.length; i++) {
			const article = articles[i];
			const newDate = articleSlots[i];

			await db
				.update(contents)
				.set({
					status: 'review',
					plannedDate: newDate,
					publishedAt: null
				})
				.where(eq(contents.id, article.id));

			// Add status history
			await db.insert(statusHistory).values({
				id: createId(),
				contentId: article.id,
				fromStatus: 'published',
				toStatus: 'review',
				changedBy: 'replan'
			});

			console.log(`  Article: ${newDate} | ${article.title.substring(0, 50)}`);
		}

		// Update GMB posts
		for (let i = 0; i < gmbs.length; i++) {
			const gmb = gmbs[i];
			const newDate = gmbSlots[i];

			// Clean title: remove "Ref interne — " prefix
			const cleanTitle = gmb.title.replace(/^Ref interne\s*[—–-]\s*/i, '');

			await db
				.update(contents)
				.set({
					title: cleanTitle,
					status: 'review',
					plannedDate: newDate,
					publishedAt: null
				})
				.where(eq(contents.id, gmb.id));

			// Add status history
			await db.insert(statusHistory).values({
				id: createId(),
				contentId: gmb.id,
				fromStatus: 'published',
				toStatus: 'review',
				changedBy: 'replan'
			});

			const renamed = cleanTitle !== gmb.title ? ` (was: ${gmb.title.substring(0, 40)})` : '';
			console.log(`  GMB:     ${newDate} | ${cleanTitle.substring(0, 50)}${renamed}`);
		}
	}

	// Summary
	const updated = await db.select().from(contents);
	const reviewCount = updated.filter((c) => c.status === 'review').length;
	console.log(`\n=== Termine ===`);
	console.log(`${reviewCount} contenus passes en review avec nouvelles dates`);
	console.log(`Planning: articles mar/jeu, GMB lun/mer/ven, a partir du 6 avril 2026`);

	process.exit(0);
}

main().catch((err) => {
	console.error('Erreur:', err);
	process.exit(1);
});
