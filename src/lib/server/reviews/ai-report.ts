import { createHash } from 'node:crypto';
import { db } from '$lib/server/db/index.js';
import { gmbAiReports } from '$lib/server/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { createId } from '$lib/server/utils.js';
import { aggregateMonthly, type MonthlyAggregate } from './aggregate-monthly.js';
import { generateMonthlyReport, getReportModel, type AiReportSummary } from '$lib/server/ai/llm.js';

export interface AiReportRecord {
	id: string;
	projectId: string;
	period: string;
	model: string;
	summary: AiReportSummary;
	inputHash: string;
	generatedAt: string;
	cached: boolean;
}

export async function findCachedReport(projectId: string, period: string): Promise<AiReportRecord | null> {
	const row = await db.query.gmbAiReports.findFirst({
		where: and(eq(gmbAiReports.projectId, projectId), eq(gmbAiReports.period, period))
	});
	if (!row) return null;
	let summary: AiReportSummary;
	try {
		summary = JSON.parse(row.summaryJson) as AiReportSummary;
	} catch {
		return null;
	}
	return {
		id: row.id,
		projectId: row.projectId,
		period: row.period,
		model: row.model,
		summary,
		inputHash: row.inputHash,
		generatedAt: row.generatedAt,
		cached: true
	};
}

export interface GenerateOptions {
	force?: boolean;
}

export async function getOrGenerateReport(
	projectId: string,
	year: number,
	month: number,
	options: GenerateOptions = {}
): Promise<{ record: AiReportRecord; aggregate: MonthlyAggregate }> {
	const period = `${year}-${String(month).padStart(2, '0')}`;
	const aggregate = await aggregateMonthly(projectId, year, month);
	if (!aggregate) throw new Error('Project not found');
	if (aggregate.stats.totalReviews === 0) {
		throw new Error('Aucun avis sur la période, rien à synthétiser.');
	}

	if (!options.force) {
		const cached = await findCachedReport(projectId, period);
		if (cached) return { record: cached, aggregate };
	}

	const inputHash = computeInputHash(aggregate);
	const summary = await generateMonthlyReport(aggregate);
	const summaryJson = JSON.stringify(summary);
	const generatedAt = new Date().toISOString();

	const existing = await db.query.gmbAiReports.findFirst({
		where: and(eq(gmbAiReports.projectId, projectId), eq(gmbAiReports.period, period))
	});

	let id: string;
	if (existing) {
		id = existing.id;
		await db
			.update(gmbAiReports)
			.set({ model: getReportModel(), summaryJson, inputHash, generatedAt })
			.where(eq(gmbAiReports.id, id));
	} else {
		id = createId();
		await db.insert(gmbAiReports).values({
			id,
			projectId,
			period,
			model: getReportModel(),
			summaryJson,
			inputHash,
			generatedAt
		});
	}

	return {
		record: {
			id,
			projectId,
			period,
			model: getReportModel(),
			summary,
			inputHash,
			generatedAt,
			cached: false
		},
		aggregate
	};
}

function computeInputHash(agg: MonthlyAggregate): string {
	const seed = JSON.stringify({
		period: agg.period,
		stats: agg.stats,
		trends: agg.trends,
		locations: agg.locations,
		employees: agg.employees,
		reviewIds: agg.reviews.map((r) => `${r.createTime}|${r.rating}|${r.comment.slice(0, 80)}`),
		prevReviewIds: agg.prevReviews.map((r) => `${r.createTime}|${r.rating}`)
	});
	return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
