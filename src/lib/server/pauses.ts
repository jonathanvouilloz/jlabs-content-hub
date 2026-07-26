/**
 * DASH-006 lot 2 — Pauses d'automatisation : l'accès à la base.
 *
 * Ce module ne contient AUCUNE règle : tout le jugement (qui couvre quoi, ce qui est
 * expiré, ce qui se lève) vit dans le module pur `pause-state.ts`. Ici on ne fait que
 * trois choses : lire le dernier événement de chaque cible, écrire une décision, et
 * relire le journal pour l'afficher.
 *
 * **Aucune table d'état.** L'état effectif n'est stocké nulle part : il se dérive du
 * journal. C'est ce qui rend l'auditabilité structurelle plutôt que déclarative — il
 * n'existe pas de booléen qui puisse diverger de son historique, puisqu'il n'existe pas
 * de booléen.
 *
 * Le client `AppDb` est injectable (même discipline que `monitoring.ts`/`findings.ts`) :
 * une seule implémentation sert les routes, les runners `scripts/` et les preuves.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { automationPauses } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { normalizeDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import {
	derivePauseStates,
	normalizePauseReason,
	normalizePauseTarget,
	pauseKey,
	type PauseEventRow,
	type PauseEventType,
	type PauseStates,
	type PauseTarget,
	type RawPauseTarget
} from './pause-state.js';

async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

// ── Lecture ─────────────────────────────────────────────────────────

/**
 * État effectif de TOUTES les cibles, à l'instant donné.
 *
 * Une seule requête, et un `DISTINCT ON` : le dernier événement par cible, jamais le
 * journal entier. La borne est donc le nombre de CIBLES (une poignée : 6 projets × 4
 * cadences + 4 providers), pas le volume d'historique — un journal qui grossit ne
 * ralentit pas la planification.
 *
 * ⚠️ Le tri secondaire est `created_at DESC, id DESC`. Deux décisions à la même seconde
 * (le format DB n'a pas les millisecondes) doivent être départagées de façon STABLE,
 * sinon un aller-retour pause/reprise dans la même seconde se résoudrait au hasard des
 * plans d'exécution. `id` vient de `createId()` : il ne porte pas l'ordre, mais il est
 * déterministe — ce qu'on veut ici, c'est un verdict reproductible, pas un arbitrage juste.
 */
export async function loadPauseStates(client?: AppDb, now: Date | string = new Date()): Promise<PauseStates> {
	const db = await resolveDb(client);
	const res = await db.execute(sql`
		SELECT DISTINCT ON (scope, project_id, cadence, provider)
		       id, scope, project_id, cadence, provider, event_type, reason, until, actor, created_at
		  FROM "seostats"."automation_pauses"
		 ORDER BY scope, project_id, cadence, provider, created_at DESC, id DESC
	`);

	const rows: PauseEventRow[] = ((res.rows ?? []) as unknown as Array<{
		id: string;
		scope: string;
		project_id: string | null;
		cadence: string | null;
		provider: string | null;
		event_type: string;
		reason: string;
		until: string | null;
		actor: string;
		created_at: string;
	}>).map((r) => ({
		id: r.id,
		scope: r.scope,
		projectId: r.project_id,
		cadence: r.cadence,
		provider: r.provider,
		eventType: r.event_type,
		reason: r.reason,
		until: r.until,
		actor: r.actor,
		createdAt: r.created_at
	}));

	return derivePauseStates(rows, now);
}

export interface PauseJournalEntry extends PauseEventRow {
	/** Slug du projet visé, résolu pour l'affichage (null pour une pause provider). */
	projectSlug: string | null;
}

/**
 * Journal lisible : qui a suspendu quoi, quand et pourquoi. Borné (défaut 50) et
 * filtrable par cible — c'est l'acceptation « pause et reprise sont auditables » vue
 * depuis l'écran.
 */
export async function listPauseJournal(input: {
	db?: AppDb;
	/** Restreint à une cible exacte (les trois champs de sa clé). */
	target?: PauseTarget | null;
	projectId?: string | null;
	limit?: number;
} = {}): Promise<PauseJournalEntry[]> {
	const db = await resolveDb(input.db);
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

	// ⚠️ Conditions écrites sur l'ALIAS `p`, pas via les colonnes drizzle : celles-ci se
	// rendent en nom pleinement qualifié (`"seostats"."automation_pauses"."project_id"`),
	// que Postgres refuse dès qu'un alias est posé dans le FROM (42P01).
	const conditions = [];
	if (input.target) {
		conditions.push(sql`p.scope = ${input.target.scope}`);
		conditions.push(
			input.target.projectId === null
				? sql`p.project_id IS NULL`
				: sql`p.project_id = ${input.target.projectId}`
		);
		conditions.push(
			input.target.cadence === null
				? sql`p.cadence IS NULL`
				: sql`p.cadence = ${input.target.cadence}`
		);
		conditions.push(
			input.target.provider === null
				? sql`p.provider IS NULL`
				: sql`p.provider = ${input.target.provider}`
		);
	} else if (input.projectId) {
		conditions.push(sql`p.project_id = ${input.projectId}`);
	}

	const res = await db.execute(sql`
		SELECT p.id, p.scope, p.project_id, p.cadence, p.provider, p.event_type,
		       p.reason, p.until, p.actor, p.created_at, pr.slug AS project_slug
		  FROM "seostats"."automation_pauses" p
		  LEFT JOIN "seostats"."projects" pr ON pr.id = p.project_id
		 ${conditions.length > 0 ? sql`WHERE ${and(...conditions)}` : sql``}
		 ORDER BY p.created_at DESC, p.id DESC
		 LIMIT ${limit}
	`);

	return ((res.rows ?? []) as unknown as Array<{
		id: string;
		scope: string;
		project_id: string | null;
		cadence: string | null;
		provider: string | null;
		event_type: string;
		reason: string;
		until: string | null;
		actor: string;
		created_at: string;
		project_slug: string | null;
	}>).map((r) => ({
		id: r.id,
		scope: r.scope,
		projectId: r.project_id,
		cadence: r.cadence,
		provider: r.provider,
		eventType: r.event_type,
		reason: r.reason,
		until: r.until,
		actor: r.actor,
		createdAt: r.created_at,
		projectSlug: r.project_slug
	}));
}

// ── Écriture ────────────────────────────────────────────────────────

export interface RecordPauseInput {
	db?: AppDb;
	/** Cible brute : validée et normalisée ici, jamais supposée correcte. */
	target: RawPauseTarget;
	eventType: PauseEventType;
	/** Obligatoire — c'est ce qui rend le journal relisible dans trois semaines. */
	reason: string;
	/** Échéance de reprise automatique (format DB). Ignorée sur un `resumed`. */
	until?: string | null;
	actor: string;
	payloadJson?: string | null;
	/** Référence de temps, injectée (rejouable, testable). */
	now?: Date | string;
}

export interface RecordPauseResult {
	eventId: string;
	/** Vrai si l'état voulu était DÉJÀ celui-là : rien n'a été écrit. */
	idempotent: boolean;
	target: PauseTarget;
	key: string;
}

/**
 * Écrit une décision de pause ou de reprise.
 *
 * **Idempotence dans la TRANSACTION, jamais par contrainte.** On relit le dernier
 * événement de la cible, on dérive son état, et si l'état voulu est déjà celui-là on
 * n'insère rien — on rend l'id de la décision qui tient toujours. Un double clic est
 * donc un NON-ÉVÉNEMENT, pas une erreur : c'est le contrat d'`approveProposal`, et
 * c'est ce qui tient l'invariant DASH-005 « double soumission = une seule ligne d'audit ».
 *
 * ⚠️ La dérivation utilisée ici est la MÊME que celle de la lecture
 * (`derivePauseStates`) : une pause `until` échue est donc considérée comme levée, et
 * re-suspendre une cible dont l'échéance vient de passer écrit bien une nouvelle ligne.
 * Une seconde implémentation « est-ce déjà en pause ? » divergerait exactement là.
 */
export async function recordPauseDecision(input: RecordPauseInput): Promise<RecordPauseResult> {
	const db = await resolveDb(input.db);
	const target = normalizePauseTarget(input.target);
	const key = pauseKey(target);
	const reason = normalizePauseReason(input.reason);
	const now = input.now ?? new Date();

	assertBoundedPayload(input.payloadJson, 'payload_json de pause');
	assertNoInlineSecret(input.payloadJson, 'payload_json de pause');

	// Une échéance n'a de sens que sur une mise en pause. En accepter une sur une
	// reprise écrirait une donnée qu'aucune lecture ne regarde — donc une promesse muette.
	const until = input.eventType === 'paused' ? (input.until ?? null) : null;
	if (until && until <= normalizeDbTimestamp(now)) {
		throw new Error('Pause : l’échéance est déjà passée, la pause n’aurait aucun effet.');
	}

	let result: RecordPauseResult | null = null;

	await db.transaction(async (tx) => {
		const previous = await tx
			.select()
			.from(automationPauses)
			.where(
				and(
					eq(automationPauses.scope, target.scope),
					target.projectId === null
						? sql`${automationPauses.projectId} IS NULL`
						: eq(automationPauses.projectId, target.projectId),
					target.cadence === null
						? sql`${automationPauses.cadence} IS NULL`
						: eq(automationPauses.cadence, target.cadence),
					target.provider === null
						? sql`${automationPauses.provider} IS NULL`
						: eq(automationPauses.provider, target.provider)
				)
			)
			.orderBy(desc(automationPauses.createdAt), desc(automationPauses.id))
			.limit(1);

		const last = previous[0];
		const currentStates = last
			? derivePauseStates(
					[
						{
							id: last.id,
							scope: last.scope,
							projectId: last.projectId,
							cadence: last.cadence,
							provider: last.provider,
							eventType: last.eventType,
							reason: last.reason,
							until: last.until,
							actor: last.actor,
							createdAt: last.createdAt
						}
					],
					now
				)
			: (new Map() as PauseStates);

		const active = currentStates.get(key) ?? null;
		const wantPaused = input.eventType === 'paused';

		// Déjà dans l'état voulu → non-événement. On rend l'id de la décision en vigueur
		// (ou celui du dernier `resumed`), pour que l'appelant puisse toujours pointer le journal.
		if (wantPaused === Boolean(active)) {
			result = {
				eventId: active?.eventId ?? last?.id ?? '',
				idempotent: true,
				target,
				key
			};
			return;
		}

		const id = createId();
		await tx.insert(automationPauses).values({
			id,
			scope: target.scope,
			projectId: target.projectId,
			cadence: target.cadence,
			provider: target.provider,
			eventType: input.eventType,
			reason,
			until,
			actor: input.actor,
			payloadJson: input.payloadJson ?? null,
			createdAt: normalizeDbTimestamp(now)
		});

		result = { eventId: id, idempotent: false, target, key };
	});

	if (!result) throw new Error('Pause : la transaction n’a produit aucun résultat.');
	return result;
}
