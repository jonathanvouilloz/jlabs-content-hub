/**
 * IDX-004 — Politique de sélection d'inspection : la BASE.
 *
 * Le SEUL endroit de ce lot qui touche la base. Tout le raisonnement vit dans le module PUR
 * `index-selection-state.ts` (testé par vitest) : ici on lit des candidats, on applique les
 * fonctions pures, on persiste des intentions.
 *
 * Le client drizzle est INJECTÉ : l'app passe son `db`, un runner `tsx` passe son propre Pool
 * (cf. `db/types.ts`). Ce module reste donc chargeable hors SvelteKit, contrairement à
 * `indexing.ts` (dette datée, qui importe `db` statiquement).
 *
 * ⚠️ L'ordre d'écriture est délibéré : **la sélection est persistée AVANT que la collecte
 * parte**. Un 429 au 3ᵉ appel sur 40 laisse alors 37 intentions non honorées, reprises au run
 * suivant sans créer une seule ligne. Persister après la collecte perdrait exactement
 * l'intention qui porte l'acceptation « une inspection manquée est replanifiée sans
 * duplication ».
 *
 * ⚠️ Ce que ce lot ne fait PAS : la cadence quotidienne `scope: 'due'`, le câblage J+3/J+7/J+28
 * à la publication (`scheduleIndexChecks`) et le CLI d'audit borné sont le LOT 2. Les raisons
 * `post_publish` et `manual` sont déjà déclarées et acceptées ici — un vocabulaire fermé se
 * déclare entier — mais rien ne les produit encore.
 */
import { and, eq, gte, lte, notExists, sql } from 'drizzle-orm';
import type { AppDb } from '../db/types.js';
import { indexObservations, indexSelection, projectProjections } from '../db/schema.js';
import { createId } from '../utils.js';
import { toDbTimestamp } from '../timestamps.js';
import { log } from '../log.js';
import { listFindings } from '../findings.js';
import { MAX_URLS_PER_JOB } from './url-inspection-state.js';
import { diffInventories, normalizeUrl } from './sitemap-state.js';
import { loadLatestInventory, loadPreviousInventory, type InventoryUrlRow } from './sitemap-inventory.js';
import {
	INDEX_TRANSITION_TYPES,
	decideStrategic,
	resolveIndexTransitionConfig
} from '../detectors/index-transition-state.js';
import {
	STRATEGIC_WINDOW_DAYS,
	loadClicksByUrl,
	loadProjectTransitionOverrides
} from '../detectors/index-transition.js';
import {
	SELECTOR_VERSION,
	SELECTION_DEFAULTS,
	addDays,
	allocate,
	isExpired,
	isSampleDue,
	isSelectionReason,
	matchesExclude,
	resolveBudget,
	resolveProjectSelection,
	resolveSelectionConfig,
	type Candidate,
	type SelectedUrl,
	type SelectionBucket,
	type SelectionConfig,
	type SelectionGuard,
	type SelectionReason,
	type ProjectSelectionOverrides
} from './index-selection-state.js';

const logger = log('index-selection');

// ── Réglages système (triptyque, cf. gsc-settings.ts) ───────────────

/** Clé portant la politique de sélection dans `system_settings`. */
export const SELECTION_SETTINGS_KEY = 'indexing.selection';

/**
 * Lit la politique en base. Clé absente, JSON cassé, table vide ou absente → défauts du code.
 * Ne lève jamais : un réglage corrompu qui ferait LEVER arrêterait toute la collecte
 * d'indexation en silence.
 */
export async function loadSelectionSettings(db: AppDb): Promise<SelectionConfig> {
	try {
		const res = await db.execute(sql`
			SELECT value FROM "seostats"."system_settings" WHERE key = ${SELECTION_SETTINGS_KEY}
		`);
		const row = (res.rows ?? [])[0] as unknown as { value: string } | undefined;
		if (!row?.value) return resolveSelectionConfig(null);
		return resolveSelectionConfig(JSON.parse(row.value) as Partial<SelectionConfig>);
	} catch (err) {
		logger.warn('politique de sélection illisible (défauts du code appliqués)', {
			error: err instanceof Error ? err.message : String(err)
		});
		return resolveSelectionConfig(null);
	}
}

/**
 * Écrit la politique. Réservé à l'outillage/exploitation (jamais l'app) : dépenser du quota
 * externe est une décision, elle se prend à la main. `updated_at` au format DB, jamais en ISO
 * (piège `timestamps.ts`).
 */
export async function saveSelectionSettings(input: {
	db: AppDb;
	config: Partial<SelectionConfig>;
	now?: Date | string;
}): Promise<void> {
	const nowDb = toDbTimestamp(input.now ?? new Date());
	await input.db.execute(sql`
		INSERT INTO "seostats"."system_settings" (key, value, description, updated_at)
		VALUES (
			${SELECTION_SETTINGS_KEY},
			${JSON.stringify(resolveSelectionConfig(input.config))},
			${'Politique de sélection et quotas d’inspection — IDX-004.'},
			${nowDb}
		)
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value,
		       description = EXCLUDED.description,
		       updated_at = EXCLUDED.updated_at
	`);
}

/**
 * Réglages PAR PROJET (`project_projections.payload`, clé `indexing.selection`).
 *
 * Jamais `system_settings` : un réglage par projet n'y va pas (note de `schema.ts`). Même
 * forme que `loadProjectTransitionOverrides` d'IDX-005, y compris la tolérance totale — un
 * payload invalide retombe sur les réglages système, il ne fait pas échouer la sélection.
 */
export async function loadProjectSelectionOverrides(
	db: AppDb,
	projectId: string
): Promise<ProjectSelectionOverrides | null> {
	try {
		const row = await db.query.projectProjections.findFirst({
			where: and(
				eq(projectProjections.projectId, projectId),
				eq(projectProjections.status, 'current')
			),
			columns: { payload: true }
		});
		if (!row?.payload) return null;
		const parsed = JSON.parse(row.payload) as {
			indexing?: { selection?: ProjectSelectionOverrides };
		};
		return parsed?.indexing?.selection ?? null;
	} catch {
		return null;
	}
}

// ── Lectures ────────────────────────────────────────────────────────

export interface DueSelectionRow {
	id: string;
	dueDate: string;
	url: string;
	urlNormalized: string;
	reason: SelectionReason;
	reasonDetail: Record<string, unknown> | null;
	bucket: SelectionBucket;
	rank: number;
}

/**
 * Les intentions DUES et NON HONORÉES.
 *
 * « Honorée » se DÉRIVE, elle ne se stocke pas :
 *   ∃ index_observations(project_id, url = url_normalized, observed_date >= due_date)
 *
 * Le `>=` porte toute la sémantique J+N : une inspection au jour 4 n'honore pas une échéance
 * J+7. Et un `NOT EXISTS` corrélé, jamais une jointure — une jointure dupliquerait la ligne
 * autant de fois que l'URL a d'observations (leçon `countFindings`, DASH-002).
 *
 * Une ligne dont la `reason` n'appartient plus au vocabulaire (écrite par une version future)
 * est ÉCARTÉE et comptée, jamais réinterprétée : deviner une raison serait inventer un
 * diagnostic.
 */
export async function loadDueSelections(input: {
	db: AppDb;
	projectId: string;
	today: string;
}): Promise<{ rows: DueSelectionRow[]; unreadable: number }> {
	const honored = input.db
		.select({ one: sql`1` })
		.from(indexObservations)
		.where(
			and(
				eq(indexObservations.projectId, indexSelection.projectId),
				eq(indexObservations.url, indexSelection.urlNormalized),
				gte(indexObservations.observedDate, indexSelection.dueDate)
			)
		);

	const rows = await input.db
		.select({
			id: indexSelection.id,
			dueDate: indexSelection.dueDate,
			url: indexSelection.url,
			urlNormalized: indexSelection.urlNormalized,
			reason: indexSelection.reason,
			reasonDetail: indexSelection.reasonDetail,
			bucket: indexSelection.bucket,
			rank: indexSelection.rank
		})
		.from(indexSelection)
		.where(
			and(
				eq(indexSelection.projectId, input.projectId),
				lte(indexSelection.dueDate, input.today),
				notExists(honored)
			)
		)
		.orderBy(indexSelection.dueDate, indexSelection.rank, indexSelection.urlNormalized);

	let unreadable = 0;
	const kept: DueSelectionRow[] = [];
	for (const r of rows) {
		if (!isSelectionReason(r.reason)) {
			unreadable += 1;
			continue;
		}
		let detail: Record<string, unknown> | null = null;
		try {
			detail = r.reasonDetail ? (JSON.parse(r.reasonDetail) as Record<string, unknown>) : null;
		} catch {
			detail = null;
		}
		kept.push({
			id: r.id,
			dueDate: r.dueDate,
			url: r.url,
			urlNormalized: r.urlNormalized,
			reason: r.reason,
			reasonDetail: detail,
			bucket: r.bucket === 'sample' ? 'sample' : 'priority',
			rank: r.rank
		});
	}
	return { rows: kept, unreadable };
}

/**
 * Appels d'inspection déjà comptés aujourd'hui, TOUS PROJETS confondus.
 *
 * ⚠️ C'est une **BORNE INFÉRIEURE**, pas une mesure : ne sont comptés ni les appels échoués,
 * ni les réponses illisibles (qui n'écrivent rien par construction, IDX-002), ni ceux du skill
 * `/seo-index-diagnose` et de la route legacy `/projects/[slug]/seo-data` — qui tapent le MÊME
 * service account. C'est précisément pourquoi `dailyPoolTotal` vaut 800 et non 2 000 : la
 * marge absorbe le sous-comptage. Ne jamais afficher « il reste N appels », toujours « au
 * plus N ».
 */
export async function loadGlobalPoolUsed(input: { db: AppDb; today: string }): Promise<number> {
	const res = await input.db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."index_observations"
		 WHERE observed_date = ${input.today}
	`);
	const row = (res.rows ?? [])[0] as unknown as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

/**
 * Dernière date d'observation par URL, sans charger les états.
 *
 * `loadLatestIndexStates` rendrait les 11 colonnes de chaque ligne pour un besoin qui tient en
 * deux : sur un inventaire de 20 000 URLs c'est du transfert pur. `DISTINCT ON` fait le reste
 * en une requête.
 */
export async function loadLastObservedByUrl(input: {
	db: AppDb;
	projectId: string;
}): Promise<Map<string, string>> {
	const res = await input.db.execute(sql`
		SELECT DISTINCT ON (url) url, observed_date
		  FROM "seostats"."index_observations"
		 WHERE project_id = ${input.projectId}
		 ORDER BY url, observed_date DESC
	`);
	const out = new Map<string, string>();
	for (const raw of res.rows ?? []) {
		const row = raw as unknown as { url: string; observed_date: string };
		out.set(row.url, row.observed_date);
	}
	return out;
}

// ── Construction des candidats ──────────────────────────────────────

/** Normalise et rejette ce qui ne peut pas être comparé à sa propre mesure. */
function toCandidate(input: {
	url: string;
	reason: SelectionReason;
	reasonDetail?: Record<string, unknown> | null;
	weight?: number;
	dueDate?: string;
}): Candidate | null {
	const normalized = normalizeUrl(input.url);
	if (!normalized.ok) return null;
	return {
		url: input.url,
		urlNormalized: normalized.normalized,
		reason: input.reason,
		reasonDetail: input.reasonDetail ?? null,
		weight: input.weight ?? 0,
		dueDate: input.dueDate
	};
}

export interface CandidateSources {
	/** Échéances reprises telles quelles — elles gardent leur raison d'origine. */
	due: Candidate[];
	findings: Candidate[];
	strategic: Candidate[];
	fresh: Candidate[];
	sample: Candidate[];
	/** Échéances abandonnées (au-delà de `maxAgeDays`) — comptées, jamais tues. */
	expired: number;
	/** Lignes dont la raison n'est plus lisible. */
	unreadable: number;
	/** Date de l'inventaire utilisé, `null` si le sitemap n'a jamais été collecté. */
	inventoryDate: string | null;
}

/**
 * Rassemble tous les candidats d'un projet.
 *
 * `scope: 'due'` s'arrête aux échéances : c'est ce qui fait de la passe quotidienne (lot 2)
 * une réserve que la configuration ne peut pas désarmer — routine et échantillon n'y entrent
 * pas, quel que soit le réglage.
 */
export async function collectCandidates(input: {
	db: AppDb;
	projectId: string;
	today: string;
	scope: 'due' | 'full';
	config: SelectionConfig;
	sampleIntervalDays: number;
	excludePatterns: readonly string[];
}): Promise<CandidateSources> {
	const excluded = (url: string) => matchesExclude(url, input.excludePatterns);

	const dueRes = await loadDueSelections({
		db: input.db,
		projectId: input.projectId,
		today: input.today
	});
	let expired = 0;
	const due: Candidate[] = [];
	for (const row of dueRes.rows) {
		if (isExpired({ dueDate: row.dueDate, today: input.today, maxAgeDays: input.config.maxAgeDays })) {
			expired += 1;
			continue;
		}
		if (excluded(row.urlNormalized)) continue;
		due.push({
			url: row.url,
			urlNormalized: row.urlNormalized,
			reason: row.reason,
			reasonDetail: row.reasonDetail,
			// Une échéance ancienne passe devant une échéance récente de même raison.
			weight: -(Date.parse(`${row.dueDate}T00:00:00Z`) || 0) / 86_400_000,
			dueDate: row.dueDate
		});
	}

	const empty: CandidateSources = {
		due,
		findings: [],
		strategic: [],
		fresh: [],
		sample: [],
		expired,
		unreadable: dueRes.unreadable,
		inventoryDate: null
	};
	if (input.scope === 'due') return empty;

	// ── Findings ouverts portant sur une page ──────────────────────
	const findingRows = await listFindings(
		{ projectId: input.projectId, types: [...INDEX_TRANSITION_TYPES], limit: 500 },
		input.db
	);
	const findings: Candidate[] = [];
	for (const f of findingRows) {
		if (f.entityType !== 'page' || !f.entityKey) continue;
		if (excluded(f.entityKey)) continue;
		const candidate = toCandidate({
			url: f.entityKey,
			reason: 'finding',
			reasonDetail: { findingId: f.id, findingType: f.type, severity: f.severity },
			weight: f.priorityScore
		});
		if (candidate) findings.push(candidate);
	}

	// ── Inventaire du jour (ou le dernier disponible) ──────────────
	const latest = await loadLatestInventory({
		db: input.db,
		projectId: input.projectId,
		onOrBefore: input.today
	});
	const inventory: InventoryUrlRow[] = latest.rows.filter((r) => !excluded(r.urlNormalized));

	// ── Nouvelles et modifiées ─────────────────────────────────────
	const fresh: Candidate[] = [];
	if (latest.date) {
		const previous = await loadPreviousInventory({
			db: input.db,
			projectId: input.projectId,
			beforeDate: latest.date
		});
		// Aucun inventaire antérieur : le premier snapshot rendrait « tout en added », ce qui
		// noierait toute autre raison sous des centaines de pages « nouvelles » qui ne le sont
		// pas. L'échantillon tournant couvre ce cas, et mieux.
		if (previous.date) {
			const byNormalized = new Map(inventory.map((r) => [r.urlNormalized, r]));
			const diff = diffInventories(previous.rows, latest.rows);
			for (const urlNormalized of diff.added) {
				const row = byNormalized.get(urlNormalized);
				// Une alternate hreflang n'est pas une page nouvelle (doctrine IDX-001).
				if (!row || row.isAlternate) continue;
				const candidate = toCandidate({
					url: row.url,
					reason: 'new',
					reasonDetail: { since: previous.date, inventoryDate: latest.date }
				});
				if (candidate) fresh.push(candidate);
			}
			for (const changed of diff.changed) {
				const row = byNormalized.get(changed.urlNormalized);
				if (!row || row.isAlternate) continue;
				const candidate = toCandidate({
					url: row.url,
					reason: 'changed',
					reasonDetail: {
						fields: changed.fields,
						lastmodFrom: changed.previous.lastmod,
						lastmodTo: changed.current.lastmod,
						since: previous.date
					}
				});
				if (candidate) fresh.push(candidate);
			}
		}
	}

	// ── Pages stratégiques (les MÊMES règles qu'IDX-005) ───────────
	const overrides = await loadProjectTransitionOverrides(input.db, input.projectId);
	const transitionConfig = resolveIndexTransitionConfig(overrides);
	const clicksByUrl = await loadClicksByUrl({
		db: input.db,
		projectId: input.projectId,
		since: addDays(input.today, -STRATEGIC_WINDOW_DAYS)
	});
	const declared = new Set<string>();
	for (const raw of transitionConfig.strategicPages) {
		const n = normalizeUrl(raw);
		if (n.ok) declared.add(n.normalized);
	}
	const strategicCtx = {
		clicksByUrl,
		declared,
		minClicks: transitionConfig.strategicMinClicks
	};
	const strategic: Candidate[] = [];
	for (const row of inventory) {
		if (row.isAlternate) continue;
		const verdict = decideStrategic(row.urlNormalized, strategicCtx);
		if (!verdict.strategic) continue;
		const candidate = toCandidate({
			url: row.url,
			reason: 'strategic',
			reasonDetail: { clicks: verdict.clicks, why: verdict.reason },
			weight: verdict.clicks
		});
		if (candidate) strategic.push(candidate);
	}

	// ── Échantillon tournant ───────────────────────────────────────
	const lastObserved = await loadLastObservedByUrl({
		db: input.db,
		projectId: input.projectId
	});
	const sample: Candidate[] = [];
	for (const row of inventory) {
		const last = lastObserved.get(row.urlNormalized) ?? null;
		if (!isSampleDue({ lastObservedDate: last, today: input.today, intervalDays: input.sampleIntervalDays })) {
			continue;
		}
		const candidate = toCandidate({
			url: row.url,
			reason: 'sample',
			reasonDetail: { lastObservedDate: last, intervalDays: input.sampleIntervalDays },
			// Jamais vue d'abord, puis la plus ancienne.
			weight: last ? -(Date.parse(`${last}T00:00:00Z`) || 0) / 86_400_000 : Number.MAX_SAFE_INTEGER
		});
		if (candidate) sample.push(candidate);
	}

	return {
		due,
		findings,
		strategic,
		fresh,
		sample,
		expired,
		unreadable: dueRes.unreadable,
		inventoryDate: latest.date
	};
}

// ── Persistance ─────────────────────────────────────────────────────

/**
 * Écrit les intentions. `ON CONFLICT DO NOTHING` sur `(projet, url_normalized, due_date)`.
 *
 * DO NOTHING et non DO UPDATE : une échéance déjà posée garde sa raison, son détail et son
 * run d'origine. La reprise d'une inspection manquée ne doit pas réécrire l'histoire de sa
 * décision — c'est ce qui rend « replanifiée sans duplication » vrai dans les deux sens
 * (aucune ligne de plus, aucune ligne modifiée).
 */
export async function persistSelections(input: {
	db: AppDb;
	projectId: string;
	selections: readonly SelectedUrl[];
	today: string;
	runId?: string | null;
}): Promise<number> {
	if (input.selections.length === 0) return 0;
	const values = input.selections.map((s) => ({
		id: createId(),
		projectId: input.projectId,
		runId: input.runId ?? null,
		schemaVersion: 1,
		dueDate: s.dueDate ?? input.today,
		url: s.url,
		urlNormalized: s.urlNormalized,
		reason: s.reason,
		reasonDetail: JSON.stringify({
			...(s.reasonDetail ?? {}),
			...(s.alsoBecause.length > 0 ? { alsoBecause: s.alsoBecause } : {})
		}),
		bucket: s.bucket,
		rank: s.rank,
		selectorVersion: SELECTOR_VERSION
	}));
	// Dédup AVANT l'insert : Postgres refuse deux lignes de même clé dans un même INSERT, et
	// une seule collision ferait rejeter tout le lot (leçon GSC-002, réappliquée par IDX-001).
	const seen = new Set<string>();
	const unique = values.filter((v) => {
		const key = `${v.urlNormalized} ${v.dueDate}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	await input.db.insert(indexSelection).values(unique).onConflictDoNothing();
	return unique.length;
}

// ── Le plan ─────────────────────────────────────────────────────────

export interface SelectionPlan {
	/** Les URLs à inspecter, dans l'ordre — forme NORMALISÉE, celle qu'on envoie à Google. */
	urls: string[];
	selections: SelectedUrl[];
	budget: number;
	poolUsed: number;
	/** Ce que le pool laissait à cette passe. « Au plus », jamais « il reste ». */
	poolAvailable: number;
	guards: SelectionGuard[];
	byReason: Partial<Record<SelectionReason, number>>;
	byBucket: Record<SelectionBucket, number>;
	sampleCap: number;
	dropped: number;
	merged: number;
	expired: number;
	unreadable: number;
	inventoryDate: string | null;
	persisted: number;
	dryRun: boolean;
	/** Pourquoi rien n'a été sélectionné, quand c'est le cas. Le silence se DIT. */
	skippedReason: string | null;
}

/**
 * Décide ce que ce job va inspecter, et l'inscrit au registre.
 *
 * Appelé par le handler `collect:url_inspection` en `mode: 'policy'`. Rend des URLs prêtes à
 * être passées à `collectUrlInspection` — même forme normalisée que celle inscrite en base,
 * sinon la jointure « honorée » ne retrouverait jamais sa mesure.
 */
export async function planInspectionSelection(input: {
	db: AppDb;
	projectId: string;
	now: Date;
	scope: 'due' | 'full';
	budget?: number | null;
	runId?: string | null;
	dryRun?: boolean;
	signal?: AbortSignal;
}): Promise<SelectionPlan> {
	const today = input.now.toISOString().slice(0, 10);
	const config = await loadSelectionSettings(input.db);
	const projectOverrides = await loadProjectSelectionOverrides(input.db, input.projectId);
	const project = resolveProjectSelection(config, projectOverrides);
	const poolUsed = await loadGlobalPoolUsed({ db: input.db, today });

	const budgetRes = resolveBudget({
		config,
		projectDailyBudget: project.dailyBudget,
		poolUsed,
		scope: input.scope,
		jobBudget: input.budget ?? null,
		collectorCap: MAX_URLS_PER_JOB
	});

	const base = {
		urls: [] as string[],
		selections: [] as SelectedUrl[],
		budget: budgetRes.budget,
		poolUsed,
		poolAvailable: budgetRes.poolAvailable,
		guards: budgetRes.guards,
		byReason: {} as Partial<Record<SelectionReason, number>>,
		byBucket: { priority: 0, sample: 0 } as Record<SelectionBucket, number>,
		sampleCap: 0,
		dropped: 0,
		merged: 0,
		expired: 0,
		unreadable: 0,
		inventoryDate: null as string | null,
		persisted: 0,
		dryRun: input.dryRun === true,
		skippedReason: null as string | null
	};

	// Budget nul : on ne lit même pas les candidats. Inutile de payer six requêtes pour
	// apprendre qu'on ne peut rien inspecter — et la cause est déjà nommée.
	if (budgetRes.budget === 0) {
		return { ...base, skippedReason: `budget nul (${budgetRes.guards.join(', ') || 'inconnu'})` };
	}
	if (input.signal?.aborted) return { ...base, skippedReason: 'interrompu avant la sélection' };

	const sources = await collectCandidates({
		db: input.db,
		projectId: input.projectId,
		today,
		scope: input.scope,
		config,
		sampleIntervalDays: project.sampleIntervalDays,
		excludePatterns: project.excludePatterns
	});

	const candidates = [
		...sources.due,
		...sources.findings,
		...sources.strategic,
		...sources.fresh,
		...sources.sample
	];

	const result = allocate({
		candidates,
		budget: budgetRes.budget,
		samplePctMax: config.samplePctMax
	});

	const guards = [...new Set([...budgetRes.guards, ...result.guards])];
	let persisted = 0;
	if (!input.dryRun && result.kept.length > 0) {
		if (input.signal?.aborted) {
			return {
				...base,
				guards,
				expired: sources.expired,
				unreadable: sources.unreadable,
				inventoryDate: sources.inventoryDate,
				skippedReason: 'interrompu avant la persistance'
			};
		}
		persisted = await persistSelections({
			db: input.db,
			projectId: input.projectId,
			selections: result.kept,
			today,
			runId: input.runId ?? null
		});
	}

	return {
		urls: result.kept.map((k) => k.urlNormalized),
		selections: result.kept,
		budget: budgetRes.budget,
		poolUsed,
		poolAvailable: budgetRes.poolAvailable,
		guards,
		byReason: result.byReason,
		byBucket: result.byBucket,
		sampleCap: result.sampleCap,
		dropped: result.dropped,
		merged: result.merged,
		expired: sources.expired,
		unreadable: sources.unreadable,
		inventoryDate: sources.inventoryDate,
		persisted,
		dryRun: input.dryRun === true,
		skippedReason:
			result.kept.length === 0
				? sources.inventoryDate === null && input.scope === 'full'
					? 'aucun inventaire sitemap et aucune échéance due'
					: `aucun candidat (${guards.join(', ') || 'rien à inspecter'})`
				: null
	};
}

/** Les défauts, réexportés pour l'outillage (CLI de réglage, lot 2). */
export { SELECTION_DEFAULTS };
