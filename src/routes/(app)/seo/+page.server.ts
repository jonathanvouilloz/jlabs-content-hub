import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, seoReports } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';

// Dashboard SEO cross-projet : tous les contenus + leurs rapports (concurrence /
// backlinks / visibilité IA), + le score visibilité IA au niveau marque/projet.
export const load: PageServerLoad = async () => {
	const [allContents, allReports] = await Promise.all([
		db
			.select({
				id: contents.id,
				title: contents.title,
				slug: contents.slug,
				type: contents.type,
				status: contents.status,
				publishedAt: contents.publishedAt,
				createdAt: contents.createdAt,
				projectId: contents.projectId,
				projectName: projects.name,
				projectColor: projects.color,
				projectSlug: projects.slug
			})
			.from(contents)
			.leftJoin(projects, eq(contents.projectId, projects.id))
			.orderBy(desc(contents.createdAt)),
		db
			.select({
				id: seoReports.id,
				projectId: seoReports.projectId,
				projectSlug: projects.slug,
				contentId: seoReports.contentId,
				reportType: seoReports.reportType,
				target: seoReports.target,
				score: seoReports.score,
				createdAt: seoReports.createdAt
			})
			.from(seoReports)
			.leftJoin(projects, eq(seoReports.projectId, projects.id))
			.orderBy(desc(seoReports.createdAt))
	]);

	// Reports triés desc → le premier vu pour une clé donnée est le plus récent.
	// Par article : dernier rapport de chaque type.
	const reportsByContent: Record<string, Record<string, { target: string | null; score: number | null; createdAt: string }>> = {};
	// Par projet (contentId null) : dernier score de visibilité IA marque.
	const brandVisibilityByProject: Record<string, { score: number | null; createdAt: string }> = {};

	for (const r of allReports) {
		if (r.contentId) {
			const bucket = (reportsByContent[r.contentId] ??= {});
			if (!bucket[r.reportType]) {
				bucket[r.reportType] = { target: r.target, score: r.score, createdAt: r.createdAt };
			}
		} else if (r.reportType === 'ai_visibility' && r.projectSlug) {
			if (!brandVisibilityByProject[r.projectSlug]) {
				brandVisibilityByProject[r.projectSlug] = { score: r.score, createdAt: r.createdAt };
			}
		}
	}

	// Liste des types présents pour le filtre.
	const types = Array.from(new Set(allContents.map((c) => c.type))).sort();

	return {
		items: allContents,
		reportsByContent,
		brandVisibilityByProject,
		types
	};
};
