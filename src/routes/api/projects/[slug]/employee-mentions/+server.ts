import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, employeeMentions } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createId } from '$lib/server/utils.js';
import { eq, and, gte, lt, like, sql } from 'drizzle-orm';

type Sentiment = 'positive' | 'neutral' | 'negative';
interface MentionInput { name: string; sentiment: Sentiment }
interface ItemInput { reviewId: string; mentions: MentionInput[] }

function isValidSentiment(s: unknown): s is Sentiment {
	return s === 'positive' || s === 'neutral' || s === 'negative';
}

function monthRange(year: number, month: number): { start: string; end: string } {
	const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
	const end = new Date(Date.UTC(year, month, 1)).toISOString();
	return { start, end };
}

export const POST: RequestHandler = async (event) => {
	const { params, request, locals, url } = event;
	const isApi = validateApiKey(event);
	const isSession = !!locals.user;
	if (!isApi && !isSession) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let body: { items?: ItemInput[] };
	try { body = await request.json(); }
	catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

	const items = body.items;
	if (!Array.isArray(items)) {
		return json({ error: 'Missing items[] in body' }, { status: 400 });
	}

	let updated = 0;
	let skipped = 0;
	const errors: string[] = [];

	const force = url.searchParams.get('force') === 'true';

	for (const item of items) {
		if (!item?.reviewId) { skipped++; continue; }

		const review = await db.query.gmbReviews.findFirst({
			where: and(eq(gmbReviews.reviewId, item.reviewId), eq(gmbReviews.projectId, project.id))
		});
		if (!review) { skipped++; errors.push(`review ${item.reviewId} not found`); continue; }

		// Idempotence : si déjà analysé, on ne réincrémente pas (sauf si force=true)
		if (review.mentionedEmployees && !force) { skipped++; continue; }

		// Si force=true et déjà analysé, on décrémente les anciens compteurs
		if (review.mentionedEmployees && force) {
			let oldMentions: { name: string; sentiment: Sentiment }[] = [];
			try { oldMentions = JSON.parse(review.mentionedEmployees); } catch { /* ignore */ }
			const dt = new Date(review.createTime);
			for (const m of oldMentions) {
				const name = m.name.trim();
				const existing = await db.query.employeeMentions.findFirst({
					where: and(
						eq(employeeMentions.projectId, project.id),
						eq(employeeMentions.employeeName, name),
						eq(employeeMentions.year, dt.getUTCFullYear()),
						eq(employeeMentions.month, dt.getUTCMonth() + 1)
					)
				});
				if (existing && existing.mentionCount > 1) {
					await db.update(employeeMentions).set({
						mentionCount: existing.mentionCount - 1,
						positiveCount: existing.positiveCount - (m.sentiment === 'positive' ? 1 : 0),
						neutralCount: existing.neutralCount - (m.sentiment === 'neutral' ? 1 : 0),
						negativeCount: existing.negativeCount - (m.sentiment === 'negative' ? 1 : 0),
						updatedAt: new Date().toISOString()
					}).where(eq(employeeMentions.id, existing.id));
				} else if (existing) {
					await db.delete(employeeMentions).where(eq(employeeMentions.id, existing.id));
				}
			}
			await db.update(gmbReviews)
				.set({ mentionedEmployees: null })
				.where(eq(gmbReviews.id, review.id));
		}

		const mentions = Array.isArray(item.mentions) ? item.mentions : [];
		const cleanMentions = mentions.filter(
			(m) => m && typeof m.name === 'string' && m.name.trim() && isValidSentiment(m.sentiment)
		);

		await db.update(gmbReviews)
			.set({ mentionedEmployees: JSON.stringify(cleanMentions) })
			.where(eq(gmbReviews.id, review.id));

		// Aggregate increments
		const dt = new Date(review.createTime);
		const year = dt.getUTCFullYear();
		const month = dt.getUTCMonth() + 1;

		for (const m of cleanMentions) {
			const name = m.name.trim();
			const existing = await db.query.employeeMentions.findFirst({
				where: and(
					eq(employeeMentions.projectId, project.id),
					eq(employeeMentions.employeeName, name),
					eq(employeeMentions.year, year),
					eq(employeeMentions.month, month)
				)
			});

			if (existing) {
				await db.update(employeeMentions).set({
					mentionCount: existing.mentionCount + 1,
					positiveCount: existing.positiveCount + (m.sentiment === 'positive' ? 1 : 0),
					neutralCount: existing.neutralCount + (m.sentiment === 'neutral' ? 1 : 0),
					negativeCount: existing.negativeCount + (m.sentiment === 'negative' ? 1 : 0),
					updatedAt: new Date().toISOString()
				}).where(eq(employeeMentions.id, existing.id));
			} else {
				await db.insert(employeeMentions).values({
					id: createId(),
					projectId: project.id,
					employeeName: name,
					year,
					month,
					mentionCount: 1,
					positiveCount: m.sentiment === 'positive' ? 1 : 0,
					neutralCount: m.sentiment === 'neutral' ? 1 : 0,
					negativeCount: m.sentiment === 'negative' ? 1 : 0
				});
			}
		}

		updated++;
	}

	return json({ ok: true, updated, skipped, errors });
};

export const GET: RequestHandler = async (event) => {
	const { params, url, locals } = event;
	const isApi = validateApiKey(event);
	const isSession = !!locals.user;
	if (!isApi && !isSession) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const now = new Date();
	const year = parseInt(url.searchParams.get('year') ?? String(now.getUTCFullYear()), 10);
	const month = parseInt(url.searchParams.get('month') ?? String(now.getUTCMonth() + 1), 10);

	if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
		return json({ error: 'Invalid year/month' }, { status: 400 });
	}

	const rows = await db
		.select()
		.from(employeeMentions)
		.where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, year),
			eq(employeeMentions.month, month)
		));

	const employees = rows
		.map((r) => ({
			name: r.employeeName,
			mention_count: r.mentionCount,
			positive_count: r.positiveCount,
			neutral_count: r.neutralCount,
			negative_count: r.negativeCount
		}))
		.sort((a, b) => b.mention_count - a.mention_count);

	// Sample reviews per employee (max 5 chacun)
	const { start, end } = monthRange(year, month);
	const sampleReviews: Record<string, Array<{ reviewId: string; authorName: string; rating: number; comment: string; createTime: string }>> = {};

	for (const emp of employees) {
		const samples = await db
			.select({
				reviewId: gmbReviews.reviewId,
				authorName: gmbReviews.authorName,
				rating: gmbReviews.rating,
				comment: gmbReviews.comment,
				createTime: gmbReviews.createTime
			})
			.from(gmbReviews)
			.where(and(
				eq(gmbReviews.projectId, project.id),
				gte(gmbReviews.createTime, start),
				lt(gmbReviews.createTime, end),
				like(gmbReviews.mentionedEmployees, sql`${'%"name":"' + emp.name + '"%'}`)
			))
			.limit(5);
		sampleReviews[emp.name] = samples;
	}

	return json({ year, month, employees, sample_reviews: sampleReviews });
};
