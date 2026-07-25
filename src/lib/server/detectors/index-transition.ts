/**
 * IDX-005 — Détecteur déterministe des transitions d'indexation.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans le module PUR
 * `index-transition-state.ts` (testé par vitest) : ici on lit des observations, on applique les
 * fonctions pures, on persiste des findings.
 *
 * Contrat FIND-001 : un détecteur = (projet, fenêtre, seuils, version) → findings. Rejouable sur un
 * snapshot figé, sans IA dans la boucle (SPEC §3.3 : le FAIT est déterministe).
 *
 * Le client drizzle est INJECTÉ : l'app passe son `db`, le runner `scripts/detect-index.ts` passe
 * son propre Pool (cf. `db/types.ts`). Ce module reste donc chargeable dans un runner `tsx`,
 * contrairement à `indexing.ts` (dette datée, qui importe `db` statiquement).
 *
 * ⚠️ **Ce détecteur n'est PAS autoritaire sur tout son projet**, à la différence de
 * `keyword_opportunity`. L'inspection coûte du quota et ne couvre qu'une sélection d'URLs : une page
 * absente de ce run n'est pas une page guérie, c'est une page qu'on n'a pas regardée. D'où le
 * `scope` passé à `reconcileDetectionRun` — sans lui, deux runs suffiraient à auto-résoudre des
 * désindexations bien réelles.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
	findings,
	gscQueryPageObservations,
	indexObservations,
	projectProjections
} from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import {
	upsertFinding,
	recordFindingEvent,
	expireSnoozes,
	reconcileDetectionRun
} from '../findings.js';
import {
	computePriorityScore,
	deriveFindingFingerprint,
	deriveSeverityEventType,
	type FindingSeverity,
	type LifecycleConfig
} from '../finding-state.js';
import { computeWindowStart } from '../observation-state.js';
import { normalizeUrl } from '../collectors/sitemap-state.js';
import { loadIndexSeries } from '../indexing-read.js';
import {
	DETECTOR_INDEX_TRANSITION,
	INDEX_TRANSITION_SKILL,
	INDEX_TRANSITION_TYPES,
	buildStateSeries,
	buildTransitionEvidence,
	buildTransitionReason,
	buildTransitionTitle,
	confirmTransition,
	decideStrategic,
	deriveTransitionSeverity,
	resolveIndexTransitionConfig,
	scoreTransition,
	shouldNotifyImmediately,
	type IndexTransitionConfig,
	type IndexTransitionType,
	type StrategicContext,
	type TransitionVerdict
} from './index-transition-state.js';

// ── Contrat d'entrée/sortie ─────────────────────────────────────────

export interface IndexTransitionInput {
	db: AppDb;
	projectId: string;
	/** Profondeur d'historique, en jours (défaut : `lookbackDays` de la config). */
	lookbackDays?: number;
	/** Date de référence `YYYY-MM-DD` — passée explicitement pour rester rejouable. */
	now?: string;
	/** Run collecteur/détecteur pour la traçabilité (`findings.run_id`). */
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides explicites (priment sur ceux de la projection projet). */
	config?: Partial<IndexTransitionConfig> | null;
	/** Overrides du cycle de vie FIND-003 (fenêtres de confirmation, veille). */
	lifecycle?: Partial<LifecycleConfig> | null;
}

export type DetectionOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

/** Un finding produit (ou qui l'aurait été en dry-run). */
export interface DetectedTransition {
	fingerprint: string;
	url: string;
	type: IndexTransitionType;
	status: 'confirmed' | 'pending';
	streak: number;
	required: number;
	previousClass: string | null;
	coverageState: string | null;
	strategic: boolean;
	strategicReason: 'declared' | 'clicks' | null;
	clicks: number;
	priorityScore: number;
	confidenceScore: number;
	severity: FindingSeverity;
	/** SPEC §14.3 — le signal ; le canal est TEL-002. */
	notifyImmediately: boolean;
	title: string;
	reason: string;
	evidenceJson: string;
	findingId: string | null;
	outcome: DetectionOutcome | null;
}

/** FIND-003 — ce que le cycle de vie a bougé pendant ce run, par type. */
export interface TransitionLifecycleReport {
	reconciled: boolean;
	snoozeExpired: number;
	reopened: number;
	autoResolved: number;
	missed: number;
	held: number;
	/**
	 * Findings d'indexation qu'aucune inspection de ce run n'a couverts — ni redétectés, ni comptés
	 * absents. Ce chiffre n'est PAS un détail : tant qu'IDX-004 ne planifie pas l'inspection, il
	 * vaudra à peu près tout le stock, et le taire ferait lire un run silencieux comme un run propre.
	 */
	outOfScope: number;
	/** Taille de la closure : URLs en problème sur cette fenêtre, AVANT troncature. */
	closureSize: number;
	/** URLs sur lesquelles ce run est autoritaire (celles qui ont une observation). */
	scopeSize: number;
}

export interface IndexTransitionResult {
	detectorVersion: string;
	projectId: string;
	config: IndexTransitionConfig;
	window: { since: string; now: string } | null;
	/** Observations d'indexation lues sur la fenêtre. */
	observationsRead: number;
	/** URLs distinctes ayant au moins une observation. */
	urlsExamined: number;
	/** URLs en problème AVANT le plafond `maxCandidates`. */
	totalMatched: number;
	/** Vrai si le plafond a tronqué la liste — jamais silencieux. */
	truncated: boolean;
	/** URLs déclarées ou mesurées stratégiques sur ce projet. */
	strategicUrls: number;
	transitions: DetectedTransition[];
	counts: Record<DetectionOutcome, number>;
	/** Findings dont la transition n'est pas encore confirmée (sévérité plafonnée). */
	pending: number;
	/** Findings marqués notifiables (§14.3) — le canal reste TEL-002. */
	notifiable: number;
	dryRun: boolean;
	/** Raison d'un run sans résultat (aucune observation…), sinon null. */
	skippedReason: string | null;
	lifecycle: TransitionLifecycleReport;
}

// ── Config par projet (projection `current`, tolérante à l'absence) ──

/**
 * Lit d'éventuels réglages par projet dans la projection courante
 * (`project_projections.payload`, clé `detectors.index_transition`). La table est vide aujourd'hui
 * (DATA-002 = expand sans backfill) et un payload invalide ne doit jamais faire échouer une
 * détection : toute anomalie retombe silencieusement sur les défauts.
 */
export async function loadProjectTransitionOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<IndexTransitionConfig> | null> {
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
			detectors?: { index_transition?: Partial<IndexTransitionConfig> };
		};
		return parsed?.detectors?.index_transition ?? null;
	} catch {
		return null;
	}
}

// ── Contexte « page stratégique » ───────────────────────────────────

/**
 * Clics GSC par page sur la fenêtre récente, indexés par URL NORMALISÉE.
 *
 * La normalisation n'est pas cosmétique : Google rend `https://site.ch/page` là où l'inventaire ou
 * l'inspection peuvent porter `https://site.ch/page#top`. Comparer les formes brutes ferait manquer
 * exactement la page qu'on cherche à protéger. `normalizeUrl` (IDX-001) est l'autorité unique de
 * cette forme — la réécrire ici la ferait diverger au premier cas limite.
 *
 * Une URL illisible est ignorée : elle ne peut pas rendre une page stratégique, et la faire échouer
 * ferait tomber tout le contexte pour une seule ligne douteuse.
 */
export async function loadClicksByUrl(input: {
	db: AppDb;
	projectId: string;
	since: string;
}): Promise<Map<string, number>> {
	const rows = await input.db
		.select({
			page: gscQueryPageObservations.page,
			clicks: sql<number>`sum(${gscQueryPageObservations.clicks})::int`
		})
		.from(gscQueryPageObservations)
		.where(
			and(
				eq(gscQueryPageObservations.projectId, input.projectId),
				gte(gscQueryPageObservations.periodStart, input.since)
			)
		)
		.groupBy(gscQueryPageObservations.page);

	const out = new Map<string, number>();
	for (const row of rows) {
		const norm = normalizeUrl(row.page);
		if (!norm.ok) continue;
		out.set(norm.normalized, (out.get(norm.normalized) ?? 0) + (row.clicks ?? 0));
	}
	return out;
}

/** Fenêtre de mesure du caractère stratégique : 28 jours (4 semaines GSC complètes). */
export const STRATEGIC_WINDOW_DAYS = 28;

// ── Exécution du détecteur ──────────────────────────────────────────

export async function runIndexTransitionDetector(
	input: IndexTransitionInput
): Promise<IndexTransitionResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;
	const now = input.now ?? new Date().toISOString().slice(0, 10);

	const projectOverrides = await loadProjectTransitionOverrides(db, projectId);
	const config = resolveIndexTransitionConfig({ ...projectOverrides, ...input.config });
	const lookbackDays = Math.max(1, Math.floor(input.lookbackDays ?? config.lookbackDays));

	const lifecycle: TransitionLifecycleReport = {
		reconciled: false,
		snoozeExpired: 0,
		reopened: 0,
		autoResolved: 0,
		missed: 0,
		held: 0,
		outOfScope: 0,
		closureSize: 0,
		scopeSize: 0
	};

	const base: IndexTransitionResult = {
		detectorVersion: DETECTOR_INDEX_TRANSITION,
		projectId,
		config,
		window: null,
		observationsRead: 0,
		urlsExamined: 0,
		totalMatched: 0,
		truncated: false,
		strategicUrls: 0,
		transitions: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		pending: 0,
		notifiable: 0,
		dryRun,
		skippedReason: null,
		lifecycle
	};

	// La veille expire AVANT la détection : un finding réveillé est traité par ce run comme
	// n'importe quel autre (rafraîchi s'il matche, hors portée sinon).
	if (!dryRun) {
		const expired = await expireSnoozes({ projectId }, db);
		lifecycle.snoozeExpired = expired.reopened.length;
	}

	const since = computeWindowStart({ now, days: lookbackDays });
	const rows = await loadIndexSeries({ db, projectId, since });
	if (rows.length === 0) {
		// Aucune observation : le run n'est autoritaire sur RIEN. Ne pas réconcilier est le point —
		// sans donnée, une absence ne prouve pas une guérison (même règle que le détecteur GSC).
		return {
			...base,
			window: { since, now },
			skippedReason:
				'aucune observation d’indexation sur la fenêtre — `collect:url_inspection` n’est pas encore planifié (IDX-004)'
		};
	}

	const series = buildStateSeries(
		rows.map((r) => ({
			url: r.url,
			observationId: r.observationId,
			observedDate: r.observedDate,
			coverageState: r.coverageState,
			indexedClass: r.indexedClass
		}))
	);

	// Contexte stratégique : mesuré (clics) + déclaré (projection). Les deux côtés passent par la
	// même normalisation, sinon la déclaration ne rejoindrait jamais la mesure.
	const clicksByUrl = await loadClicksByUrl({
		db,
		projectId,
		since: computeWindowStart({ now, days: STRATEGIC_WINDOW_DAYS })
	});
	const declared = new Set<string>();
	for (const raw of config.strategicPages) {
		const norm = normalizeUrl(raw);
		if (norm.ok) declared.add(norm.normalized);
	}
	const strategicCtx: StrategicContext = {
		clicksByUrl,
		declared,
		minClicks: config.strategicMinClicks
	};

	// ── Jugement, URL par URL ────────────────────────────────────────
	interface Judged {
		verdict: TransitionVerdict;
		fingerprint: string;
		strategic: ReturnType<typeof decideStrategic>;
		priorityScore: number;
		severity: FindingSeverity;
		detected: DetectedTransition;
	}

	const judged: Judged[] = [];
	/** Portée d'autorité : toute URL observée sur la fenêtre, en problème ou non. */
	const scope = new Map<IndexTransitionType, Set<string>>();
	for (const type of INDEX_TRANSITION_TYPES) scope.set(type, new Set());
	let strategicUrls = 0;

	for (const s of series) {
		const norm = normalizeUrl(s.url);
		const key = norm.ok ? norm.normalized : s.url;
		const strategic = decideStrategic(key, strategicCtx);
		if (strategic.strategic) strategicUrls += 1;

		// La portée couvre les TROIS types pour toute URL observée : une page qui portait un
		// `crawled_not_indexed` et qui est redevenue indexée doit pouvoir se résoudre, et ça
		// suppose que ce run se déclare autoritaire sur elle pour ce type-là aussi.
		for (const type of INDEX_TRANSITION_TYPES) {
			scope.get(type)!.add(
				deriveFindingFingerprint({ type, entityType: 'page', entityKey: s.url })
			);
		}

		const verdict = confirmTransition(s, config);
		if (!verdict) continue;

		const score = scoreTransition({ verdict, strategic, config });
		const priorityScore = computePriorityScore(score);
		const severity = deriveTransitionSeverity({
			verdict,
			strategic: strategic.strategic,
			priorityScore
		});
		const fingerprint = deriveFindingFingerprint({
			type: verdict.type,
			entityType: 'page',
			entityKey: s.url
		});
		const evidenceJson = JSON.stringify(
			buildTransitionEvidence({ verdict, strategic, score, series: s, config })
		);

		judged.push({
			verdict,
			fingerprint,
			strategic,
			priorityScore,
			severity,
			detected: {
				fingerprint,
				url: s.url,
				type: verdict.type,
				status: verdict.status,
				streak: verdict.streak,
				required: verdict.required,
				previousClass: verdict.previousClass,
				coverageState: verdict.coverageState,
				strategic: strategic.strategic,
				strategicReason: strategic.reason,
				clicks: strategic.clicks,
				priorityScore,
				confidenceScore: verdict.confidenceScore,
				severity,
				notifyImmediately: shouldNotifyImmediately({
					verdict,
					strategic: strategic.strategic
				}),
				title: buildTransitionTitle(verdict),
				reason: buildTransitionReason(verdict),
				evidenceJson,
				findingId: null,
				outcome: null
			}
		});
	}

	// Ordre déterministe : le plus prioritaire d'abord, départagé par l'URL. Sans ordre TOTAL, le
	// plafond `maxCandidates` retiendrait un lot différent à chaque exécution sur les mêmes données.
	judged.sort((a, b) =>
		b.priorityScore !== a.priorityScore
			? b.priorityScore - a.priorityScore
			: a.verdict.url < b.verdict.url
				? -1
				: a.verdict.url > b.verdict.url
					? 1
					: 0
	);

	const cap = Math.max(0, Math.floor(config.maxCandidates));
	const kept = judged.slice(0, cap);
	const truncated = judged.length > cap;

	// La closure couvre TOUS les problèmes détectés, pas seulement ceux qu'on écrit : un finding
	// absent d'une closure tronquée passerait pour guéri (leçon FIND-003, barberconcept).
	const closure = new Map<IndexTransitionType, Set<string>>();
	for (const type of INDEX_TRANSITION_TYPES) closure.set(type, new Set());
	for (const j of judged) closure.get(j.verdict.type)!.add(j.fingerprint);

	const counts: Record<DetectionOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};
	const transitions: DetectedTransition[] = [];

	// Sévérités déjà connues, en une seule requête (pas une par candidat) → sert à dériver
	// l'événement de transition sans relire ligne par ligne.
	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);

	for (const j of kept) {
		if (dryRun) {
			transitions.push(j.detected);
			continue;
		}

		const previousSeverity = known.get(j.fingerprint) ?? null;
		const upserted = await upsertFinding(
			{
				projectId,
				type: j.verdict.type,
				entityType: 'page',
				entityKey: j.verdict.url,
				fingerprint: j.fingerprint,
				title: j.detected.title,
				severity: j.severity,
				priorityScore: j.priorityScore,
				confidenceScore: j.verdict.confidenceScore,
				impactEstimateJson: JSON.stringify({
					clicksAtRisk: j.strategic.clicks,
					strategic: j.strategic.strategic,
					notifyImmediately: j.detected.notifyImmediately
				}),
				evidenceJson: j.detected.evidenceJson,
				detectorVersion: DETECTOR_INDEX_TRANSITION,
				recommendedSkill: INDEX_TRANSITION_SKILL,
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création, ou mouvement de
		// sévérité. C'est l'acceptation (1) : une transition STABLE ne produit qu'un seul événement,
		// même redétectée chaque semaine.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, j.severity)
			: null;
		const outcome: DetectionOutcome = upserted.isNew ? 'created' : (severityEvent ?? 'refreshed');

		if (outcome !== 'refreshed') {
			await recordFindingEvent(
				{
					findingId: upserted.id,
					projectId,
					eventType: upserted.isNew ? 'created' : outcome,
					toStatus: upserted.isNew ? 'open' : null,
					reason: j.detected.reason,
					actor: 'detector',
					payloadJson: JSON.stringify({
						detector: DETECTOR_INDEX_TRANSITION,
						priorityScore: j.priorityScore,
						severity: j.severity,
						previousSeverity,
						confirmation: j.verdict.status,
						notifyImmediately: j.detected.notifyImmediately
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		transitions.push({ ...j.detected, findingId: upserted.id, outcome });
	}

	lifecycle.closureSize = judged.length;
	lifecycle.scopeSize = series.length;

	// ── FIND-003 — réconciliation, UNE PASSE PAR TYPE ────────────────
	// Un `reconcileDetectionRun` par type parce que la closure d'un type ne dit rien des autres :
	// mélanger les trois ferait passer pour absente toute page dont le problème a simplement CHANGÉ
	// de nature (un `discovered_not_indexed` devenu `crawled_not_indexed`).
	if (!dryRun) {
		for (const type of INDEX_TRANSITION_TYPES) {
			const reconciled = await reconcileDetectionRun(
				{
					projectId,
					type,
					closure: closure.get(type)!,
					scope: scope.get(type)!,
					detectorVersion: DETECTOR_INDEX_TRANSITION,
					runId: input.runId ?? null,
					config: input.lifecycle
				},
				db
			);
			lifecycle.reopened += reconciled.reopened;
			lifecycle.autoResolved += reconciled.autoResolved;
			lifecycle.missed += reconciled.missed;
			lifecycle.held += reconciled.held;
			lifecycle.outOfScope += reconciled.outOfScope;
		}
		lifecycle.reconciled = true;
	}

	return {
		...base,
		window: { since, now },
		observationsRead: rows.length,
		urlsExamined: series.length,
		totalMatched: judged.length,
		truncated,
		strategicUrls,
		transitions,
		counts,
		pending: transitions.filter((t) => t.status === 'pending').length,
		notifiable: transitions.filter((t) => t.notifyImmediately).length,
		lifecycle
	};
}

/**
 * Sévérités des findings d'indexation déjà connus du projet, indexées par fingerprint. Les trois
 * types en une seule requête : le fingerprint porte déjà le type, donc aucune collision possible.
 */
async function loadKnownSeverities(db: AppDb, projectId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ fingerprint: findings.fingerprint, severity: findings.severity })
		.from(findings)
		.where(
			and(
				eq(findings.projectId, projectId),
				inArray(findings.type, [...INDEX_TRANSITION_TYPES])
			)
		);
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}

/** Compte les projets ayant au moins une observation d'indexation (utile au runner `--project=all`). */
export async function listProjectsWithIndexObservations(
	db: AppDb
): Promise<{ projectId: string; observations: number }[]> {
	return db
		.select({
			projectId: indexObservations.projectId,
			observations: sql<number>`count(*)::int`
		})
		.from(indexObservations)
		.groupBy(indexObservations.projectId);
}
