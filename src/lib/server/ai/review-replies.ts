import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { Mention } from '$lib/server/reviews/mentions.js';
import { isValidSentiment } from '$lib/server/reviews/mentions.js';
import { getClient, getReportModel } from './llm.js';

export interface ReviewInput {
	reviewId: string;
	authorName: string;
	rating: number;
	comment: string;
	locationLabel: string;
	createTime: string;
}

export interface PerReviewError {
	reviewId: string;
	authorName: string;
	error: string;
}

export type StreamEvent =
	| { kind: 'success'; review: ReviewInput; reply: string; mentions: Mention[] }
	| { kind: 'error'; review: ReviewInput; error: string };

const SYSTEM_INSTRUCTIONS = `Tu es chargé de rédiger une réponse personnalisée à UN avis Google pour un commerce local, ET d'identifier les membres de l'équipe cités dans cet avis.

Règles absolues pour la réponse :
- Réponds dans la langue du commentaire (FR→FR, EN→EN, DE→DE). Si pas de commentaire, réponds en français.
- Utilise le prénom du client si disponible, et mentionne un détail spécifique de son avis.
- Longueur : positif court (1-2 lignes) = 2-3 phrases ; positif long = 3-5 phrases ; négatif = 4-6 phrases max. Jamais plus de 8 phrases.
- Adapte le ton au profil business fourni.
- Si le projet a plusieurs établissements, mentionne le nom de l'établissement concerné.

Ton par note :
- 5★ avec texte → amplifier la satisfaction, valoriser l'équipe si mentionnée
- 5★ sans texte → bref remerciement sincère + une valeur ajoutée
- 4★ → souligner le positif + légère ouverture vers encore mieux
- 3★ → commencer positif, reconnaître l'expérience mitigée sans se défausser
- 2★ → assumer, proposer une action concrète, inviter à revenir
- 1★ → empathie, explication factuelle (pas d'excuse vide), proposer une résolution directe

Signatures :
- Avis positifs (4★ et 5★) : utiliser la signature par défaut fournie
- Avis négatifs ou mitigés (1★ à 3★) : utiliser la signature négative fournie

Patterns IA interdits (violation immédiate si présents) :
- Vocabulaire : "crucial", "vibrant", "foster", "enhance", "testament", "showcase", "delve", "captivating"
- Superlatifs vides : "votre satisfaction est notre priorité absolue", "c'est avec grand plaisir"
- Em dashes (—) : remplacer par virgule, point ou parenthèse
- Groupes de trois forcés : "A, B et C" systématique
- Sycophantie : "quelle belle remarque !", "super retour !"
- "être" verbeux : préférer "c'est" à "cela constitue", "il s'agit de"
- Formules génériques : "nous restons à votre entière disposition", "n'hésitez pas à nous contacter"
- Annonces : "nous tenons à souligner que", "il est important de préciser"
- Gras dans la réponse
- Répétition du mot "établissement"

Règles absolues pour les mentions employés (champ "mentions" de l'outil) :
- N'identifie QUE les personnes présentes dans la liste "Équipe" du contexte business. Si la liste est vide ou absente, retourne mentions: [].
- Sont valides : prénom exact, surnom courant (Soso/Sophie, Flo/Florent, Manu/Emmanuel), faute d'orthographe évidente (Sofia/Sophia, Kévyn/Kévin), référence contextuelle claire ("le patron", "le coiffeur" si une seule personne dans l'équipe).
- INTERDIT : inventer un nom absent de l'équipe, matcher un mot commun qui ressemble à un prénom (ex: "marche" ne matche PAS "Marc"), deviner sur une référence ambiguë.
- Pour chaque mention, le sentiment exprimé ENVERS CETTE PERSONNE (pas le sentiment global de l'avis) : "positive" | "neutral" | "negative".
  Exemple : "Sophie était top mais l'attente longue" → Sophie = positive.
  Exemple : "Sophie géniale, Léa désagréable" → Sophie=positive, Léa=negative.
- Le champ "name" de chaque mention doit être le nom canonique tel qu'il apparaît dans l'équipe (pas le surnom utilisé par le client).
- Si aucun employé identifiable, retourne mentions: [].

Tu DOIS appeler l'outil "submit_reply" avec ta réponse ET les mentions. N'écris rien en dehors de l'outil.`;

const TOOL_SCHEMA: ChatCompletionTool = {
	type: 'function',
	function: {
		name: 'submit_reply',
		description: "Envoie la réponse rédigée pour l'avis Google fourni, et la liste des membres de l'équipe cités.",
		parameters: {
			type: 'object',
			required: ['reply', 'mentions'],
			properties: {
				reply: {
					type: 'string',
					description: "La réponse rédigée pour cet avis."
				},
				mentions: {
					type: 'array',
					description: "Membres de l'équipe (teamMembers) cités dans l'avis avec leur sentiment. Tableau vide si aucun.",
					items: {
						type: 'object',
						required: ['name', 'sentiment'],
						properties: {
							name: {
								type: 'string',
								description: "Nom canonique du membre tel qu'il apparaît dans la liste Équipe."
							},
							sentiment: {
								type: 'string',
								enum: ['positive', 'neutral', 'negative'],
								description: "Sentiment exprimé ENVERS CETTE PERSONNE dans l'avis."
							}
						}
					}
				}
			}
		}
	}
};

function buildContextBlock(ctx: ProjectContext, isMultiLocation: boolean): string {
	const lines: string[] = [];
	lines.push(`Établissement : ${ctx.businessName}`);
	if (ctx.businessType) lines.push(`Type : ${ctx.businessType}`);
	if (ctx.locality) lines.push(`Localité : ${ctx.locality}`);
	if (ctx.tone) lines.push(`Ton : ${ctx.tone}`);
	if (ctx.keyServices?.length) lines.push(`Services : ${ctx.keyServices.join(', ')}`);
	if (ctx.values?.length) lines.push(`Valeurs : ${ctx.values.join(', ')}`);
	if (ctx.teamMembers?.length) {
		const team = ctx.teamMembers.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(', ');
		lines.push(`Équipe : ${team}`);
	}
	if (ctx.contactEmail) lines.push(`Contact (avis négatifs) : ${ctx.contactEmail}${ctx.contactPhone ? ' / ' + ctx.contactPhone : ''}`);
	lines.push(`Signature positive : ${ctx.defaultSignature}`);
	lines.push(`Signature négative : ${ctx.negativeSignature}`);
	if (isMultiLocation) lines.push('⚠️ Plusieurs établissements : mentionner le nom de l\'établissement dans la réponse.');
	return lines.join('\n');
}

function buildReviewBlock(r: ReviewInput): string {
	const comment = (r.comment || '').replace(/\s+/g, ' ').trim();
	const date = r.createTime.slice(0, 10);
	return [
		`Auteur : ${r.authorName}`,
		`Note : ${r.rating}★`,
		`Établissement : ${r.locationLabel}`,
		`Date : ${date}`,
		`Commentaire : ${comment || '(sans commentaire)'}`
	].join('\n');
}

const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 4;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriable(err: unknown): boolean {
	const e = err as { status?: number; message?: string };
	const status = e?.status;
	if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return true;
	const msg = e?.message ?? '';
	return /\b429\b|rate limit|max .* concurrency/i.test(msg);
}

function parseRetryAfterSec(err: unknown): number | null {
	const msg = (err as { message?: string })?.message ?? '';
	const m = msg.match(/(?:try again after|retry after)\s+(\d+)\s*(s|second|seconds|ms|millisecond)?/i);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (Number.isNaN(n)) return null;
	const unit = (m[2] || 's').toLowerCase();
	return unit.startsWith('ms') ? n / 1000 : n;
}

interface ReplyResult { reply: string; mentions: Mention[] }

function parseMentionsArg(input: unknown, knownNames: string[]): Mention[] {
	if (!Array.isArray(input)) return [];
	const known = new Set(knownNames.map((n) => n.toLowerCase()));
	return input
		.filter((m): m is { name: unknown; sentiment: unknown } => !!m && typeof m === 'object')
		.map((m) => ({
			name: typeof m.name === 'string' ? m.name.trim() : '',
			sentiment: m.sentiment
		}))
		.filter((m) => m.name && isValidSentiment(m.sentiment))
		// Hard guardrail : si la liste équipe est connue, on rejette tout nom qui n'y figure pas
		// (case-insensitive). Si la liste est vide, on autorise (le LLM doit déjà retourner []).
		.filter((m) => known.size === 0 || known.has(m.name.toLowerCase()))
		.map((m) => ({ name: m.name, sentiment: m.sentiment as Mention['sentiment'] }));
}

async function generateOneReply(
	review: ReviewInput,
	context: ProjectContext,
	isMultiLocation: boolean
): Promise<ReplyResult> {
	const llm = getClient();

	const userPayload = `# Contexte business
${buildContextBlock(context, isMultiLocation)}

# Avis à traiter
${buildReviewBlock(review)}`;

	const teamNames = (context.teamMembers ?? []).map((m) => m.name).filter(Boolean);

	let lastErr: unknown = null;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await llm.chat.completions.create({
				model: getReportModel(),
				max_tokens: 800,
				stream: false,
				messages: [
					{ role: 'system', content: SYSTEM_INSTRUCTIONS },
					{ role: 'user', content: userPayload }
				],
				tools: [TOOL_SCHEMA],
				tool_choice: { type: 'function', function: { name: 'submit_reply' } },
				thinking: { type: 'disabled' }
			} as Parameters<(typeof llm.chat.completions)['create']>[0] & { stream: false });

			const toolCall = response.choices[0]?.message?.tool_calls?.[0];
			if (!toolCall || toolCall.type !== 'function') {
				throw new Error("Le modèle n'a pas appelé l'outil submit_reply");
			}
			const fn = (toolCall as { type: 'function'; function: { name: string; arguments: string } }).function;
			if (fn.name !== 'submit_reply') {
				throw new Error(`Outil inattendu : ${fn.name}`);
			}

			const parsed = JSON.parse(fn.arguments) as { reply?: string; mentions?: unknown };
			const reply = parsed.reply?.trim();
			if (!reply) throw new Error("Le modèle a renvoyé une réponse vide");
			const mentions = parseMentionsArg(parsed.mentions, teamNames);
			return { reply, mentions };
		} catch (err) {
			lastErr = err;
			if (attempt === MAX_RETRIES || !isRetriable(err)) throw err;
			const hint = parseRetryAfterSec(err);
			const baseMs = hint != null ? hint * 1000 : 1000 * Math.pow(2, attempt);
			const jitter = Math.floor(Math.random() * 400);
			await sleep(baseMs + jitter);
		}
	}
	throw lastErr;
}

export async function streamAiReplies(
	reviews: ReviewInput[],
	context: ProjectContext,
	isMultiLocation: boolean,
	onProgress: (event: StreamEvent) => Promise<void>
): Promise<void> {
	if (reviews.length === 0) return;

	let cursor = 0;
	const writeMutex: { p: Promise<void> } = { p: Promise.resolve() };

	// Sérialise les appels au callback (writes DB) pour éviter
	// des updates concurrents sur la même row ai_jobs.
	function emit(event: StreamEvent): Promise<void> {
		const next = writeMutex.p.then(() => onProgress(event));
		writeMutex.p = next.catch(() => undefined);
		return next;
	}

	async function worker() {
		while (true) {
			const i = cursor++;
			if (i >= reviews.length) return;
			const review = reviews[i];
			try {
				const { reply, mentions } = await generateOneReply(review, context, isMultiLocation);
				await emit({ kind: 'success', review, reply, mentions });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await emit({ kind: 'error', review, error: msg });
			}
		}
	}

	const workerCount = Math.min(MAX_CONCURRENCY, reviews.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
