import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { validateClientToken } from '$lib/server/api-auth.js';
import { aggregateMonthly } from '$lib/server/reviews/aggregate-monthly.js';
import { findCachedReport } from '$lib/server/reviews/ai-report.js';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const token = url.searchParams.get('token');
	const session = locals.user ? { isAdmin: true } : null;

	let projectId: string | null = null;

	if (session) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.slug, params.slug)
		});
		if (!project) throw error(404, 'Not found');
		projectId = project.id;
	} else {
		if (!token) throw error(404, 'Not found');
		const client = await validateClientToken(token);
		if (!client || client.projectSlug !== params.slug) throw error(404, 'Not found');
		projectId = client.projectId;
	}

	const match = params.period.match(/^(\d{4})-(\d{2})$/);
	if (!match) throw error(400, 'Format attendu: YYYY-MM');
	const year = parseInt(match[1]);
	const month = parseInt(match[2]);

	const aggregate = await aggregateMonthly(projectId, year, month);
	if (!aggregate) throw error(404, 'Not found');

	const period = `${year}-${String(month).padStart(2, '0')}`;
	const cached = await findCachedReport(projectId, period);

	const prevStars = Object.fromEntries(
		[1, 2, 3, 4, 5].map((s) => [s, aggregate.prevReviews.filter((r) => r.rating === s).length])
	) as Record<number, number>;

	return {
		project: { name: aggregate.project.name, color: aggregate.project.color, slug: aggregate.project.slug },
		period: { year, month, label: aggregate.period.label },
		prevPeriod: aggregate.prevPeriod,
		stats: aggregate.stats,
		trends: aggregate.trends,
		prevStars,
		locations: aggregate.locations,
		employees: aggregate.employees,
		employeeSamples: aggregate.employeeSamples,
		reviews: aggregate.reviews.map((r) => ({
			authorName: r.authorName,
			rating: r.rating,
			comment: r.comment,
			draftReply: r.draftReply,
			repliedAt: r.repliedAt,
			createTime: r.createTime,
			locationLabel: r.locationLabel
		})),
		aiSummary: cached
			? { summary: cached.summary, generatedAt: cached.generatedAt, model: cached.model }
			: null,
		isAdmin: !!session
	};
};
