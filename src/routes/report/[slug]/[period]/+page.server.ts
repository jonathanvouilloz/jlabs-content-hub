import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, employeeMentions } from '$lib/server/db/schema.js';
import { eq, and, gte, lt, desc, like } from 'drizzle-orm';
import { validateClientToken } from '$lib/server/api-auth.js';

export const load: PageServerLoad = async ({ params, url }) => {
	const token = url.searchParams.get('token');
	if (!token) throw error(404, 'Not found');

	const client = await validateClientToken(token);
	if (!client || client.projectSlug !== params.slug) throw error(404, 'Not found');

	// Parse period YYYY-MM
	const match = params.period.match(/^(\d{4})-(\d{2})$/);
	if (!match) throw error(400, 'Format attendu: YYYY-MM');
	const year = parseInt(match[1]);
	const month = parseInt(match[2]);

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Not found');

	// Date range for current month
	const monthStart = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
	const nextMonth = month === 12 ? `${year + 1}-01-01T00:00:00` : `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

	// Previous month for trends
	const prevYear = month === 1 ? year - 1 : year;
	const prevMonth = month === 1 ? 12 : month - 1;
	const prevMonthStart = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01T00:00:00`;

	// Fetch reviews for current month (ALL — replied or not)
	const reviews = await db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, monthStart),
			lt(gmbReviews.createTime, nextMonth)
		))
		.orderBy(desc(gmbReviews.createTime));

	// Fetch reviews for previous month (for trends)
	const prevReviews = await db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, prevMonthStart),
			lt(gmbReviews.createTime, monthStart)
		));

	// Employee mentions for current month
	const employees = await db
		.select()
		.from(employeeMentions)
		.where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, year),
			eq(employeeMentions.month, month)
		));

	// Employee mentions for previous month (trends)
	const prevEmployees = await db
		.select()
		.from(employeeMentions)
		.where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, prevYear),
			eq(employeeMentions.month, prevMonth)
		));

	// Sample reviews per employee (max 3)
	const employeeSamples: Record<string, typeof reviews> = {};
	for (const emp of employees) {
		const samples = await db
			.select()
			.from(gmbReviews)
			.where(and(
				eq(gmbReviews.projectId, project.id),
				gte(gmbReviews.createTime, monthStart),
				lt(gmbReviews.createTime, nextMonth),
				like(gmbReviews.mentionedEmployees, `%"name":"${emp.employeeName}"%`)
			))
			.orderBy(desc(gmbReviews.createTime))
			.limit(3);
		if (samples.length > 0) {
			employeeSamples[emp.employeeName] = samples;
		}
	}

	// Compute stats
	const totalReviews = reviews.length;
	const avgRating = totalReviews > 0
		? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
		: 0;

	const prevTotal = prevReviews.length;
	const prevAvgRating = prevTotal > 0
		? prevReviews.reduce((sum, r) => sum + r.rating, 0) / prevTotal
		: 0;

	// Star distribution
	const stars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const r of reviews) stars[r.rating] = (stars[r.rating] || 0) + 1;

	// Per location stats
	const locationMap = new Map<string, { count: number; ratingSum: number; stars: Record<number, number> }>();
	for (const r of reviews) {
		const loc = locationMap.get(r.locationLabel) ?? { count: 0, ratingSum: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
		loc.count++;
		loc.ratingSum += r.rating;
		loc.stars[r.rating]++;
		locationMap.set(r.locationLabel, loc);
	}
	const locations = Array.from(locationMap.entries()).map(([label, data]) => ({
		label,
		count: data.count,
		avgRating: data.ratingSum / data.count,
		stars: data.stars
	}));

	// Period label
	const monthNames = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];
	const periodLabel = `${monthNames[month - 1]} ${year}`;
	const prevPeriodLabel = `${monthNames[prevMonth - 1]} ${prevYear}`;

	return {
		project: { name: project.name, color: project.color },
		period: { year, month, label: periodLabel },
		prevPeriod: { year: prevYear, month: prevMonth, label: prevPeriodLabel },
		stats: {
			totalReviews,
			avgRating: Math.round(avgRating * 10) / 10,
			positivePercent: totalReviews > 0 ? Math.round((stars[4] + stars[5]) / totalReviews * 100) : 0,
			stars
		},
		trends: {
			prevTotal,
			prevAvgRating: Math.round(prevAvgRating * 10) / 10,
			deltaVolume: totalReviews - prevTotal,
			deltaRating: Math.round((avgRating - prevAvgRating) * 10) / 10,
			prevMentions: prevEmployees.reduce((s, e) => s + e.mentionCount, 0),
			currentMentions: employees.reduce((s, e) => s + e.mentionCount, 0)
		},
		locations,
		employees: employees.map(e => ({
			name: e.employeeName,
			mentionCount: e.mentionCount,
			positiveCount: e.positiveCount,
			neutralCount: e.neutralCount,
			negativeCount: e.negativeCount
		})),
		employeeSamples,
		reviews: reviews.map(r => ({
			authorName: r.authorName,
			rating: r.rating,
			comment: r.comment,
			draftReply: r.draftReply,
			repliedAt: r.repliedAt,
			createTime: r.createTime,
			locationLabel: r.locationLabel
		}))
	};
};
