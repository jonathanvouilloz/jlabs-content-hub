import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { ProjectContext } from '$lib/types/project-context.js';
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
	| { kind: 'success'; review: ReviewInput; reply: string }
	| { kind: 'error'; review: ReviewInput; error: string };

const SYSTEM_INSTRUCTIONS = `Tu es chargé de rédiger une réponse personnalisée à UN avis Google pour un commerce local.

Règles absolues :
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

Tu DOIS appeler l'outil "submit_reply" avec ta réponse. N'écris rien en dehors de l'outil.`;

const TOOL_SCHEMA: ChatCompletionTool = {
	type: 'function',
	function: {
		name: 'submit_reply',
		description: "Envoie la réponse rédigée pour l'avis Google fourni.",
		parameters: {
			type: 'object',
			required: ['reply'],
			properties: {
				reply: {
					type: 'string',
					description: "La réponse rédigée pour cet avis."
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

async function generateOneReply(
	review: ReviewInput,
	context: ProjectContext,
	isMultiLocation: boolean
): Promise<string> {
	const llm = getClient();

	const userPayload = `# Contexte business
${buildContextBlock(context, isMultiLocation)}

# Avis à traiter
${buildReviewBlock(review)}`;

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

			const parsed = JSON.parse(fn.arguments) as { reply?: string };
			const reply = parsed.reply?.trim();
			if (!reply) throw new Error("Le modèle a renvoyé une réponse vide");
			return reply;
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
				const reply = await generateOneReply(review, context, isMultiLocation);
				await emit({ kind: 'success', review, reply });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await emit({ kind: 'error', review, error: msg });
			}
		}
	}

	const workerCount = Math.min(MAX_CONCURRENCY, reviews.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
