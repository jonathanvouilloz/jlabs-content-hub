/**
 * DATA-007 — Écriture des politiques d'avis & d'automatisation (SPEC §7.10).
 *
 * - `promotePolicy` : versionne une policy. Même config re-soumise → no-op
 *   (`deduped`, aucune promotion). Config différente → nouvelle version `current`,
 *   l'ancienne passe `superseded`, et une ligne append-only est écrite dans
 *   `policy_promotions` (« tracer toute promotion »). Transactionnel : l'invariant
 *   « une seule policy courante par scope » ne peut pas se casser à mi-chemin.
 * - `setKillSwitch` : bascule le kill switch = une promotion à part entière
 *   (nouvelle version, journalisée `kind='kill_switch'`). Le kill switch bloque les
 *   envois SANS toucher `sync_enabled` (invariant porté par policy-state).
 * - `getCurrentPolicy` / `getEffectivePolicy` : lecture de la version courante ;
 *   `getEffectivePolicy` combine la policy de localisation et le kill switch
 *   projet-wide (un des deux suffit à bloquer les envois).
 *
 * Garde commune : les blobs JSON (fenêtres, catégories) sont BORNÉS
 * (assertBoundedPayload) et sans secret (assertNoInlineSecret) avant persistance.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { reviewAutomationPolicies, policyPromotions } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import { toDbTimestamp } from './timestamps.js';
import {
	canonicalPolicyConfig,
	deriveScopeKey,
	derivePromotionKind,
	nextPolicyVersion,
	resolveEffectiveKillSwitch,
	type PolicyConfig
} from './policy-state.js';

/**
 * Format DB canonique (cf. `timestamps.ts`) : `promoted_at` a un DEFAULT SQL au
 * format `YYYY-MM-DD HH24:MI:SS`. Mélanger de l'ISO dans la même colonne rendrait
 * l'historique des promotions incomparable lexicalement — donc intriable.
 */
const nowDb = () => toDbTimestamp();

/**
 * Client d'écriture : celui de l'app par défaut, ou un client INJECTÉ (runner
 * `scripts/`). Import DYNAMIQUE de `db/index.js`, comme `findings.ts` : sinon ce
 * module tire `$env/dynamic/private` et devient inchargeable hors SvelteKit.
 */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

/** Hash canonique d'une config de policy : sha256 hex de sa sérialisation stable.
 *  Toute modification de la config change le hash → nouvelle version au lieu d'un no-op. */
export function computePolicyHash(config: PolicyConfig): string {
	return createHash('sha256').update(canonicalPolicyConfig(config)).digest('hex');
}

function guardConfigBlobs(config: PolicyConfig): void {
	assertBoundedPayload(config.sendWindowsJson, 'send_windows_json policy');
	assertNoInlineSecret(config.sendWindowsJson, 'send_windows_json policy');
	assertBoundedPayload(config.escalationCategoriesJson, 'escalation_categories_json policy');
	assertNoInlineSecret(config.escalationCategoriesJson, 'escalation_categories_json policy');
}

// ── Lecture ─────────────────────────────────────────────────────────

/** Policy courante d'un scope (projet + localisation, ou projet-wide si locationId absent). */
export async function getCurrentPolicy(
	projectId: string,
	locationId?: string | null,
	client?: AppDb
) {
	const scopeKey = deriveScopeKey(locationId);
	const db = await resolveDb(client);
	return db.query.reviewAutomationPolicies.findFirst({
		where: and(
			eq(reviewAutomationPolicies.projectId, projectId),
			eq(reviewAutomationPolicies.scopeKey, scopeKey),
			eq(reviewAutomationPolicies.status, 'current')
		)
	});
}

/**
 * Policy effective pour une localisation : la policy courante de la localisation
 * (ou undefined), plus le kill switch effectif combinant la localisation et la
 * policy projet-wide. Un kill switch actif à l'un ou l'autre niveau bloque les envois.
 */
export async function getEffectivePolicy(
	projectId: string,
	locationId: string,
	client?: AppDb
) {
	const [location, projectWide] = await Promise.all([
		getCurrentPolicy(projectId, locationId, client),
		getCurrentPolicy(projectId, null, client)
	]);
	return {
		policy: location,
		projectWide,
		effectiveKillSwitch: resolveEffectiveKillSwitch({
			locationKillSwitch: location?.killSwitch,
			projectKillSwitch: projectWide?.killSwitch
		})
	};
}

// ── Promotion (versionnage + journal) ───────────────────────────────

export interface PromotePolicyInput {
	projectId: string;
	locationId?: string | null;
	config: PolicyConfig;
	actor: string; // qui promeut (user|agent|policy|system)
	reason?: string | null;
}

export interface PromotePolicyResult {
	id: string;
	version: number;
	/** true si la config est identique à la courante → aucune nouvelle version. */
	deduped: boolean;
	/** id de la ligne policy_promotions (absent si deduped). */
	promotionId?: string;
	/** id de la version précédemment courante passée `superseded` (si remplacement). */
	supersededId?: string;
}

/**
 * Promeut une policy pour un scope. Dédup par hash de config ; versionne sinon.
 * Le remplacement (superseded → insert current) et l'écriture du journal sont
 * transactionnels : « une seule policy courante par scope » reste vrai à tout instant.
 */
export async function promotePolicy(
	input: PromotePolicyInput,
	client?: AppDb
): Promise<PromotePolicyResult> {
	guardConfigBlobs(input.config);
	const scopeKey = deriveScopeKey(input.locationId);
	const hash = computePolicyHash(input.config);
	const db = await resolveDb(client);

	return db.transaction(async (tx) => {
		const currentRows = await tx
			.select()
			.from(reviewAutomationPolicies)
			.where(
				and(
					eq(reviewAutomationPolicies.projectId, input.projectId),
					eq(reviewAutomationPolicies.scopeKey, scopeKey),
					eq(reviewAutomationPolicies.status, 'current')
				)
			)
			.limit(1);
		const current = currentRows[0];

		// Config identique → no-op : ne pas empiler une version qui ne change rien.
		if (current && current.policyHash === hash) {
			return { id: current.id, version: current.version, deduped: true };
		}

		const id = createId();
		const version = nextPolicyVersion(current?.version);
		const now = nowDb();

		if (current) {
			await tx
				.update(reviewAutomationPolicies)
				.set({ status: 'superseded' })
				.where(eq(reviewAutomationPolicies.id, current.id));
		}

		await tx.insert(reviewAutomationPolicies).values({
			id,
			projectId: input.projectId,
			locationId: input.locationId ?? null,
			scopeKey,
			version,
			policyHash: hash,
			mode: input.config.mode,
			syncEnabled: input.config.syncEnabled,
			autoGenerationEnabled: input.config.autoGenerationEnabled,
			killSwitch: input.config.killSwitch,
			minRatingForAutoSend: input.config.minRatingForAutoSend ?? null,
			sendDelayMinutes: input.config.sendDelayMinutes ?? null,
			jitterMinutes: input.config.jitterMinutes ?? null,
			sendWindowsJson: input.config.sendWindowsJson ?? null,
			defaultLanguage: input.config.defaultLanguage ?? null,
			signature: input.config.signature ?? null,
			escalationCategoriesJson: input.config.escalationCategoriesJson ?? null,
			maxSendsPerRun: input.config.maxSendsPerRun ?? null,
			status: 'current',
			promotedBy: input.actor,
			promotedAt: now
		});

		const kind = derivePromotionKind({
			hadPrevious: Boolean(current),
			modeChanged: Boolean(current) && current!.mode !== input.config.mode,
			killSwitchChanged: Boolean(current) && current!.killSwitch !== input.config.killSwitch
		});

		const promotionId = createId();
		await tx.insert(policyPromotions).values({
			id: promotionId,
			projectId: input.projectId,
			policyId: id,
			fromPolicyId: current?.id ?? null,
			scopeKey,
			fromVersion: current?.version ?? null,
			toVersion: version,
			fromMode: current?.mode ?? null,
			toMode: input.config.mode,
			kind,
			actor: input.actor,
			reason: input.reason ?? null
		});

		return { id, version, deduped: false, promotionId, supersededId: current?.id };
	});
}

// ── Kill switch (bascule = promotion journalisée) ───────────────────

/** Config par défaut sûre quand aucune policy n'existe encore pour un scope. */
const DEFAULT_CONFIG: PolicyConfig = {
	mode: 'draft_only',
	syncEnabled: true,
	autoGenerationEnabled: false,
	killSwitch: false
};

/**
 * Bascule le kill switch d'un scope. C'est une promotion à part entière : nouvelle
 * version, journalisée (`kind='kill_switch'` si seul le kill switch change). Si aucune
 * policy n'existe, en crée une `draft_only` sûre avec le kill switch demandé. Le kill
 * switch bloque les envois ; `sync_enabled` n'est jamais touché ici.
 */
export async function setKillSwitch(input: {
	projectId: string;
	locationId?: string | null;
	on: boolean;
	actor: string;
	reason?: string | null;
}, client?: AppDb): Promise<PromotePolicyResult> {
	const current = await getCurrentPolicy(input.projectId, input.locationId, client);
	const base: PolicyConfig = current
		? {
				mode: current.mode,
				syncEnabled: current.syncEnabled,
				autoGenerationEnabled: current.autoGenerationEnabled,
				killSwitch: current.killSwitch,
				minRatingForAutoSend: current.minRatingForAutoSend,
				sendDelayMinutes: current.sendDelayMinutes,
				jitterMinutes: current.jitterMinutes,
				sendWindowsJson: current.sendWindowsJson,
				defaultLanguage: current.defaultLanguage,
				signature: current.signature,
				escalationCategoriesJson: current.escalationCategoriesJson,
				maxSendsPerRun: current.maxSendsPerRun
			}
		: { ...DEFAULT_CONFIG };

	return promotePolicy(
		{
			projectId: input.projectId,
			locationId: input.locationId,
			config: { ...base, killSwitch: input.on },
			actor: input.actor,
			reason: input.reason ?? (input.on ? 'kill switch activé' : 'kill switch désactivé')
		},
		client
	);
}
