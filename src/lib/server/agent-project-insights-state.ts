export interface AgentProjectInsightsInput {
	project: { slug: string; name: string };
	snapshot: {
		id?: string;
		errorMessage?: string | null;
		weekStart: string;
		weekEnd: string;
		fetchedAt: string;
		status: string;
		totalClicks: number;
		totalImpressions: number;
		avgCtr: number;
		avgPosition: number;
	} | null;
	diff: unknown;
	actions: { opportunities: unknown[]; quickWins: unknown[] };
	movers: { gains: unknown[]; losses: unknown[] };
	cannibalization: unknown[];
}

/**
 * Projection API dédiée à l'agent : uniquement des agrégats et décisions SEO
 * exploitables. Les identifiants internes, erreurs provider et credentials ne
 * traversent jamais cette frontière.
 */
export function buildAgentProjectInsights(input: AgentProjectInsightsInput) {
	if (!input.snapshot) {
		return {
			project: input.project,
			freshness: { status: 'not_collected' as const },
			gsc: null
		};
	}

	return {
		project: input.project,
		freshness: {
			status: input.snapshot.status,
			weekStart: input.snapshot.weekStart,
			weekEnd: input.snapshot.weekEnd,
			fetchedAt: input.snapshot.fetchedAt
		},
		gsc: {
			clicks: input.snapshot.totalClicks,
			impressions: input.snapshot.totalImpressions,
			ctr: input.snapshot.avgCtr,
			position: input.snapshot.avgPosition,
			diff: input.diff,
			opportunities: input.actions.opportunities,
			quickWins: input.actions.quickWins,
			movers: input.movers,
			cannibalization: input.cannibalization
		}
	};
}
