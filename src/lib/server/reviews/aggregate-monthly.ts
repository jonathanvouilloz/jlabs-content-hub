import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, employeeMentions, projectContexts } from '$lib/server/db/schema.js';
import { eq, and, gte, lt, desc, ilike } from 'drizzle-orm';
import type { ProjectContext } from '$lib/types/project-context.js';

export interface ReviewItem {
	authorName: string;
	rating: number;
	comment: string;
	draftReply: string | null;
	repliedAt: string | null;
	createTime: string;
	locationLabel: string;
	mentionedEmployees: string | null;
}

export interface LocationStats {
	label: string;
	count: number;
	avgRating: number;
	stars: Record<number, number>;
}

export interface EmployeeStats {
	name: string;
	mentionCount: number;
	positiveCount: number;
	neutralCount: number;
	negativeCount: number;
}

export interface MonthlyAggregate {
	project: { id: string; name: string; color: string; slug: string };
	projectContext: ProjectContext | null;
	period: { year: number; month: number; label: string };
	prevPeriod: { year: number; month: number; label: string };
	stats: {
		totalReviews: number;
		avgRating: number;
		positivePercent: number;
		stars: Record<number, number>;
	};
	trends: {
		prevTotal: number;
		prevAvgRating: number;
		deltaVolume: number;
		deltaRating: number;
		prevMentions: number;
		currentMentions: number;
	};
	locations: LocationStats[];
	employees: EmployeeStats[];
	employeeSamples: Record<string, ReviewItem[]>;
	reviews: ReviewItem[];
	prevReviews: ReviewItem[];
}

const MONTH_NAMES = [
	'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
	'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'
];

export async function aggregateMonthly(
	projectId: string,
	year: number,
	month: number
): Promise<MonthlyAggregate | null> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId)
	});
	if (!project) return null;

	const monthStart = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
	const nextMonth = month === 12
		? `${year + 1}-01-01T00:00:00`
		: `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

	const prevYear = month === 1 ? year - 1 : year;
	const prevMonth = month === 1 ? 12 : month - 1;
	const prevMonthStart = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01T00:00:00`;

	const reviews = await db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, monthStart),
			lt(gmbReviews.createTime, nextMonth)
		))
		.orderBy(desc(gmbReviews.createTime));

	const prevReviews = await db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, prevMonthStart),
			lt(gmbReviews.createTime, monthStart)
		));

	const employees = await db
		.select()
		.from(employeeMentions)
		.where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, year),
			eq(employeeMentions.month, month)
		));

	const prevEmployees = await db
		.select()
		.from(employeeMentions)
		.where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, prevYear),
			eq(employeeMentions.month, prevMonth)
		));

	const employeeSamples: Record<string, ReviewItem[]> = {};
	for (const emp of employees) {
		const samples = await db
			.select()
			.from(gmbReviews)
			.where(and(
				eq(gmbReviews.projectId, project.id),
				gte(gmbReviews.createTime, monthStart),
				lt(gmbReviews.createTime, nextMonth),
				ilike(gmbReviews.mentionedEmployees, `%"name":"${emp.employeeName}"%`)
			))
			.orderBy(desc(gmbReviews.createTime))
			.limit(3);
		if (samples.length > 0) {
			employeeSamples[emp.employeeName] = samples.map(toReviewItem);
		}
	}

	const totalReviews = reviews.length;
	const avgRating = totalReviews > 0
		? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
		: 0;
	const prevTotal = prevReviews.length;
	const prevAvgRating = prevTotal > 0
		? prevReviews.reduce((sum, r) => sum + r.rating, 0) / prevTotal
		: 0;

	const stars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const r of reviews) stars[r.rating] = (stars[r.rating] || 0) + 1;

	const locationMap = new Map<string, { count: number; ratingSum: number; stars: Record<number, number> }>();
	for (const r of reviews) {
		const loc = locationMap.get(r.locationLabel) ?? { count: 0, ratingSum: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
		loc.count++;
		loc.ratingSum += r.rating;
		loc.stars[r.rating]++;
		locationMap.set(r.locationLabel, loc);
	}
	const locations: LocationStats[] = Array.from(locationMap.entries()).map(([label, data]) => ({
		label,
		count: data.count,
		avgRating: data.ratingSum / data.count,
		stars: data.stars
	}));

	// Project context (used to ground the AI summary)
	const ctxRow = await db.query.projectContexts.findFirst({
		where: eq(projectContexts.projectId, project.id)
	});
	let projectContext: ProjectContext | null = null;
	if (ctxRow?.context) {
		try {
			projectContext = JSON.parse(ctxRow.context) as ProjectContext;
		} catch {
			projectContext = null;
		}
	}

	return {
		project: { id: project.id, name: project.name, color: project.color, slug: project.slug },
		projectContext,
		period: { year, month, label: `${MONTH_NAMES[month - 1]} ${year}` },
		prevPeriod: { year: prevYear, month: prevMonth, label: `${MONTH_NAMES[prevMonth - 1]} ${prevYear}` },
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
		employees: employees.map((e) => ({
			name: e.employeeName,
			mentionCount: e.mentionCount,
			positiveCount: e.positiveCount,
			neutralCount: e.neutralCount,
			negativeCount: e.negativeCount
		})),
		employeeSamples,
		reviews: reviews.map(toReviewItem),
		prevReviews: prevReviews.map(toReviewItem)
	};
}

function toReviewItem(r: typeof gmbReviews.$inferSelect): ReviewItem {
	return {
		authorName: r.authorName,
		rating: r.rating,
		comment: r.comment,
		draftReply: r.draftReply,
		repliedAt: r.repliedAt,
		createTime: r.createTime,
		locationLabel: r.locationLabel,
		mentionedEmployees: r.mentionedEmployees
	};
}
