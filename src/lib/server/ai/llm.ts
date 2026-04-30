import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { env } from '$env/dynamic/private';
import type { MonthlyAggregate, ReviewItem } from '../reviews/aggregate-monthly.js';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2.6';

export function getReportModel(): string {
	return env.LLM_MODEL || DEFAULT_MODEL;
}

function getBaseUrl(): string {
	return env.LLM_BASE_URL || DEFAULT_BASE_URL;
}

export interface AiReportSummary {
	executive_summary: string;
	trend_vs_previous: {
		verdict: 'improved' | 'stable' | 'declined';
		highlights: string[];
	};
	by_location: {
		location_label: string;
		verdict: 'improved' | 'stable' | 'declined';
		summary: string;
		strengths: string[];
		watch_points: string[];
		actions: string[];
	}[];
	team_highlights: {
		employee: string;
		context: string;
		recommendation: string;
	}[];
	actions_recommended: {
		priority: 'high' | 'medium' | 'low';
		action: string;
		reason: string;
	}[];
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
	if (!client) {
		const apiKey = env.LLM_API_KEY;
		if (!apiKey) throw new Error('LLM_API_KEY missing in environment');
		client = new OpenAI({ apiKey, baseURL: getBaseUrl() });
	}
	return client;
}

const SYSTEM_INSTRUCTIONS = `Tu es un analyste éditorial qui rédige une synthèse mensuelle des avis Google pour un client local (commerce, salon, cabinet…).

Ton style :
- calme, factuel, posé — jamais marketing, jamais flatteur
- ancré dans les avis réels : ne fabrique pas d'exemple, n'invente pas de chiffre
- direct et utile : le client doit savoir quoi faire après lecture
- français suisse romand (sans helvétismes lourds), pas d'anglicismes inutiles
- pas d'emoji
- pas de formules creuses ("nous sommes ravis", "excellents résultats")

Méthode :
1. Compare le mois courant avec le précédent (volume, note, sentiment, par salon, par employé). Le verdict doit refléter une vraie variation, pas du bruit (<2 avis ou ±0.1 étoile = stable).
2. Pour chaque salon/établissement, donne un mini diagnostic : ce qui marche, ce qui pose question, et 1 à 3 actions concrètes ancrées dans les commentaires reçus.
3. Mets en lumière les membres de l'équipe cités positivement ; signale les mentions négatives sans les diaboliser.
4. Termine par 2 à 5 actions priorisées (high / medium / low) avec une justification courte qui cite l'avis ou le pattern qui la motive.

Tu DOIS appeler l'outil "submit_report" pour rendre ta synthèse. N'écris pas de texte hors de l'outil.`;

const TOOL_SCHEMA: ChatCompletionTool = {
	type: 'function',
	function: {
		name: 'submit_report',
		description: 'Envoie la synthèse mensuelle structurée des avis Google.',
		parameters: {
			type: 'object',
			required: ['executive_summary', 'trend_vs_previous', 'by_location', 'team_highlights', 'actions_recommended'],
			properties: {
				executive_summary: {
					type: 'string',
					description: '3 à 5 phrases. Verdict global du mois, ton calme et factuel.'
				},
				trend_vs_previous: {
					type: 'object',
					required: ['verdict', 'highlights'],
					properties: {
						verdict: { type: 'string', enum: ['improved', 'stable', 'declined'] },
						highlights: {
							type: 'array',
							items: { type: 'string' },
							description: '3 à 5 points clés de comparaison vs mois précédent (volume, note, sentiment, par salon).'
						}
					}
				},
				by_location: {
					type: 'array',
					description: 'Un objet par établissement présent dans le mois courant.',
					items: {
						type: 'object',
						required: ['location_label', 'verdict', 'summary', 'strengths', 'watch_points', 'actions'],
						properties: {
							location_label: { type: 'string' },
							verdict: { type: 'string', enum: ['improved', 'stable', 'declined'] },
							summary: { type: 'string', description: '2 à 3 phrases.' },
							strengths: { type: 'array', items: { type: 'string' } },
							watch_points: { type: 'array', items: { type: 'string' } },
							actions: { type: 'array', items: { type: 'string' }, description: '1 à 3 actions concrètes.' }
						}
					}
				},
				team_highlights: {
					type: 'array',
					description: "Mentions notables de membres de l'équipe (positives ou négatives).",
					items: {
						type: 'object',
						required: ['employee', 'context', 'recommendation'],
						properties: {
							employee: { type: 'string' },
							context: { type: 'string', description: 'Ce que disent les avis.' },
							recommendation: { type: 'string' }
						}
					}
				},
				actions_recommended: {
					type: 'array',
					description: '2 à 5 actions priorisées pour le mois suivant.',
					items: {
						type: 'object',
						required: ['priority', 'action', 'reason'],
						properties: {
							priority: { type: 'string', enum: ['high', 'medium', 'low'] },
							action: { type: 'string' },
							reason: { type: 'string', description: "Pourquoi — ancré dans les avis ou le pattern." }
						}
					}
				}
			}
		}
	}
};

function summariseEmployees(emps: MonthlyAggregate['employees']): string {
	if (emps.length === 0) return '(aucune mention employé enregistrée ce mois)';
	return emps
		.slice()
		.sort((a, b) => b.mentionCount - a.mentionCount)
		.map((e) => `- ${e.name} : ${e.mentionCount} mention(s) (${e.positiveCount}+ / ${e.neutralCount} neutre / ${e.negativeCount}-)`)
		.join('\n');
}

function summariseReviews(reviews: ReviewItem[], cap = 25): string {
	if (reviews.length === 0) return '(aucun avis sur la période)';
	const negatives = reviews.filter((r) => r.rating <= 3);
	const positives = reviews.filter((r) => r.rating >= 4);
	const positivesSample = positives.slice(0, Math.max(0, cap - negatives.length));
	const picked = [...negatives, ...positivesSample].slice(0, cap);
	return picked
		.map((r) => {
			const date = r.createTime.slice(0, 10);
			const comment = (r.comment || '').replace(/\s+/g, ' ').trim().slice(0, 400);
			const employees = parseEmployees(r.mentionedEmployees);
			const empPart = employees.length > 0 ? ` [équipe: ${employees.join(', ')}]` : '';
			return `- ${date} | ${r.locationLabel} | ${r.rating}★ | ${r.authorName}${empPart}\n  ${comment || '(sans commentaire)'}`;
		})
		.join('\n');
}

function parseEmployees(json: string | null): string[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as { name?: string }[];
		return arr.map((e) => e?.name).filter((x): x is string => !!x);
	} catch {
		return [];
	}
}

function summariseLocations(locs: MonthlyAggregate['locations']): string {
	if (locs.length === 0) return '(aucun établissement actif sur la période)';
	return locs
		.map((l) => {
			const dist = [5, 4, 3, 2, 1].map((s) => `${s}★:${l.stars[s] ?? 0}`).join(' ');
			return `- ${l.label} : ${l.count} avis, moyenne ${Math.round(l.avgRating * 10) / 10} (${dist})`;
		})
		.join('\n');
}

function buildContextBlock(agg: MonthlyAggregate): string {
	const ctx = agg.projectContext;
	const lines: string[] = [];
	lines.push(`Projet : ${agg.project.name}`);
	if (ctx) {
		if (ctx.businessType) lines.push(`Type d'activité : ${ctx.businessType}`);
		if (ctx.locality) lines.push(`Localité : ${ctx.locality}`);
		if (ctx.tone) lines.push(`Ton attendu : ${ctx.tone}`);
		if (ctx.keyServices?.length) lines.push(`Services clés : ${ctx.keyServices.join(', ')}`);
		if (ctx.values?.length) lines.push(`Valeurs : ${ctx.values.join(', ')}`);
		if (ctx.teamMembers?.length) {
			const team = ctx.teamMembers.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(', ');
			lines.push(`Équipe : ${team}`);
		}
		if (ctx.geoZone) lines.push(`Zone : ${ctx.geoZone}`);
	} else {
		lines.push('(profil business non configuré pour ce projet)');
	}
	return lines.join('\n');
}

export async function generateMonthlyReport(agg: MonthlyAggregate): Promise<AiReportSummary> {
	const llm = getClient();

	const userPayload = `# Contexte business
${buildContextBlock(agg)}

# Période analysée
Mois courant : ${agg.period.label}
Mois précédent : ${agg.prevPeriod.label}

# Statistiques globales
- Avis ce mois : ${agg.stats.totalReviews} (vs ${agg.trends.prevTotal} le mois précédent → Δ ${agg.trends.deltaVolume >= 0 ? '+' : ''}${agg.trends.deltaVolume})
- Note moyenne : ${agg.stats.avgRating} / 5 (vs ${agg.trends.prevAvgRating} → Δ ${agg.trends.deltaRating >= 0 ? '+' : ''}${agg.trends.deltaRating})
- Avis positifs (4-5★) : ${agg.stats.positivePercent}%
- Distribution étoiles : ${[5, 4, 3, 2, 1].map((s) => `${s}★:${agg.stats.stars[s] ?? 0}`).join(' / ')}
- Mentions équipe ce mois : ${agg.trends.currentMentions} (vs ${agg.trends.prevMentions})

# Par établissement (mois courant)
${summariseLocations(agg.locations)}

# Mentions équipe (mois courant)
${summariseEmployees(agg.employees)}

# Avis du mois courant (priorité aux ≤3★, échantillon 4-5★)
${summariseReviews(agg.reviews, 30)}

# Avis du mois précédent (échantillon, pour calibrer la comparaison)
${summariseReviews(agg.prevReviews, 10)}`;

	const response = await llm.chat.completions.create({
		model: getReportModel(),
		max_tokens: 4000,
		stream: false,
		messages: [
			{ role: 'system', content: SYSTEM_INSTRUCTIONS },
			{ role: 'user', content: userPayload }
		],
		tools: [TOOL_SCHEMA],
		tool_choice: { type: 'function', function: { name: 'submit_report' } },
		thinking: { type: 'disabled' }
	} as Parameters<(typeof llm.chat.completions)['create']>[0] & { stream: false });

	const toolCall = response.choices[0]?.message?.tool_calls?.[0];
	if (!toolCall || toolCall.type !== 'function') {
		throw new Error("Le modèle n'a pas appelé l'outil submit_report");
	}
	const fn = (toolCall as { type: 'function'; function: { name: string; arguments: string } }).function;
	if (fn.name !== 'submit_report') {
		throw new Error(`Outil inattendu : ${fn.name}`);
	}
	return JSON.parse(fn.arguments) as AiReportSummary;
}
