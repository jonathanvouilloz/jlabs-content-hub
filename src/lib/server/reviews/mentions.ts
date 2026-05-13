import { db } from '$lib/server/db/index.js';
import { gmbReviews, employeeMentions } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { eq, and } from 'drizzle-orm';

export type Sentiment = 'positive' | 'neutral' | 'negative';
export interface Mention { name: string; sentiment: Sentiment }

export type PersistResult = 'updated' | 'skipped' | 'not_found';

export function isValidSentiment(s: unknown): s is Sentiment {
	return s === 'positive' || s === 'neutral' || s === 'negative';
}

export function sanitizeMentions(input: unknown): Mention[] {
	if (!Array.isArray(input)) return [];
	return input
		.filter((m): m is { name: unknown; sentiment: unknown } => !!m && typeof m === 'object')
		.filter((m) => typeof m.name === 'string' && (m.name as string).trim() && isValidSentiment(m.sentiment))
		.map((m) => ({ name: (m.name as string).trim(), sentiment: m.sentiment as Sentiment }));
}

export async function decrementMonthlyAggregate(
	projectId: string,
	mentions: Mention[],
	year: number,
	month: number
): Promise<void> {
	for (const m of mentions) {
		const name = m.name.trim();
		const existing = await db.query.employeeMentions.findFirst({
			where: and(
				eq(employeeMentions.projectId, projectId),
				eq(employeeMentions.employeeName, name),
				eq(employeeMentions.year, year),
				eq(employeeMentions.month, month)
			)
		});
		if (!existing) continue;
		if (existing.mentionCount > 1) {
			await db.update(employeeMentions).set({
				mentionCount: existing.mentionCount - 1,
				positiveCount: existing.positiveCount - (m.sentiment === 'positive' ? 1 : 0),
				neutralCount: existing.neutralCount - (m.sentiment === 'neutral' ? 1 : 0),
				negativeCount: existing.negativeCount - (m.sentiment === 'negative' ? 1 : 0),
				updatedAt: new Date().toISOString()
			}).where(eq(employeeMentions.id, existing.id));
		} else {
			await db.delete(employeeMentions).where(eq(employeeMentions.id, existing.id));
		}
	}
}

async function incrementMonthlyAggregate(
	projectId: string,
	mentions: Mention[],
	year: number,
	month: number
): Promise<void> {
	for (const m of mentions) {
		const name = m.name.trim();
		const existing = await db.query.employeeMentions.findFirst({
			where: and(
				eq(employeeMentions.projectId, projectId),
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
				projectId,
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
}

/**
 * Persist mentions for a review and update the monthly aggregate.
 * Idempotent : si l'avis a deja un mentionedEmployees != null et force=false, on skip.
 * Si force=true, on decremente d'abord les anciens compteurs avant d'inserer les nouveaux.
 */
export async function persistMentionsForReview(
	projectId: string,
	reviewId: string,
	rawMentions: unknown,
	options: { force?: boolean } = {}
): Promise<PersistResult> {
	const force = options.force === true;

	const review = await db.query.gmbReviews.findFirst({
		where: and(eq(gmbReviews.reviewId, reviewId), eq(gmbReviews.projectId, projectId))
	});
	if (!review) return 'not_found';

	if (review.mentionedEmployees && !force) return 'skipped';

	const dt = new Date(review.createTime);
	const year = dt.getUTCFullYear();
	const month = dt.getUTCMonth() + 1;

	if (review.mentionedEmployees && force) {
		let oldMentions: Mention[] = [];
		try { oldMentions = JSON.parse(review.mentionedEmployees); } catch { /* ignore */ }
		await decrementMonthlyAggregate(projectId, oldMentions, year, month);
		await db.update(gmbReviews)
			.set({ mentionedEmployees: null })
			.where(eq(gmbReviews.id, review.id));
	}

	const cleanMentions = sanitizeMentions(rawMentions);

	await db.update(gmbReviews)
		.set({ mentionedEmployees: JSON.stringify(cleanMentions) })
		.where(eq(gmbReviews.id, review.id));

	await incrementMonthlyAggregate(projectId, cleanMentions, year, month);

	return 'updated';
}

/**
 * Decremente l'agregat employee_mentions a partir d'une row d'avis avant
 * suppression. No-op si mentionedEmployees est null/vide/invalide.
 * Utilise par DELETE /reviews/[id] pour eviter les agregats orphelins.
 */
export async function decrementMentionsForReviewRow(
	projectId: string,
	row: { mentionedEmployees: string | null; createTime: string }
): Promise<void> {
	if (!row.mentionedEmployees) return;
	let parsed: unknown;
	try { parsed = JSON.parse(row.mentionedEmployees); }
	catch { return; }
	const mentions = sanitizeMentions(parsed);
	if (mentions.length === 0) return;
	const dt = new Date(row.createTime);
	const year = dt.getUTCFullYear();
	const month = dt.getUTCMonth() + 1;
	await decrementMonthlyAggregate(projectId, mentions, year, month);
}
