/**
 * REP-003 — Publication du rapport du lundi : la BASE.
 *
 * Le modèle pur vit dans `report-publication-state.ts` (testé par vitest) ; ici on lit les
 * runs du créneau, on applique la décision, et on écrit **au plus une** ligne par semaine.
 * Client drizzle INJECTÉ, comme partout depuis GSC-002 : c'est ce qui rend ce lot prouvable
 * sur Neon hors runtime SvelteKit.
 *
 * ⚠️ **La publication n'est pas un job de la file, et ce n'est pas un oubli.** `jobs.project_id`
 * et `monitoring_runs.project_id` sont NOT NULL, alors que le rapport est cross-projet : un
 * `report:weekly` au catalogue hebdo aurait produit neuf jobs pour un seul rapport, dont huit
 * sans effet — et un no-op est indistinguable d'un incident dans une console de file. Pire, les
 * arêtes de JOB-004 sont INTRA-occurrence (même projet, même run) : elles ne peuvent pas
 * exprimer « attendre les steps des neuf projets ». L'attente cross-projet vit donc ici, bornée
 * par une échéance, et le tick l'appelle après son drain.
 *
 * ⚠️ **Le contenu est une fonction du CRÉNEAU, pas de l'instant de publication.** `loadWeeklyReport`
 * reçoit `now = slot` : la période couverte est donc la semaine qui précède lundi 09:00, que la
 * publication tombe à 09:05 ou (après une panne) le mercredi. Sans cette ancre, deux
 * publications du même lundi porteraient deux périodes différentes, et REP-004 comparerait des
 * semaines qui ne se recouvrent pas.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { monitoringRuns, weeklyReports } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { log } from './log.js';
import { loadPauseStates } from './pauses.js';
import { resolveCadencePause } from './pause-state.js';
import { listSchedulableProjects } from './scheduler.js';
import { CADENCE_RUN_TYPE, SCHEDULE_DEFAULTS } from './schedule-state.js';
import { dbTimestampToMs, toDbTimestamp } from './timestamps.js';
import { loadWeeklyReport } from './weekly-report.js';
import { REPORT_SCHEMA_VERSION, type WeeklyReport } from './weekly-report-state.js';
import {
	currentPublicationSlot,
	decidePublication,
	deriveSlo,
	renderPublicationAnnouncement,
	resolvePublishDeadlineMinutes,
	PUBLICATION_SCHEMA_VERSION,
	type ProjectRunInput,
	type PublicationAnnouncement,
	type PublicationDecision,
	type PublicationReadiness,
	type PublicationReason,
	type PublicationStatus,
	type SloVerdict
} from './report-publication-state.js';

const logger = log('report-publication');

/** Clé portant l'échéance de publication dans `system_settings` (réglable sans redéploiement). */
export const PUBLISH_DEADLINE_KEY = 'report.publish_deadline_minutes';

async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

// ── Réglage de l'échéance ───────────────────────────────────────────

/**
 * Lit l'échéance en base. Clé absente, JSON cassé, table vide → défaut du code (60 min, soit
 * 10:00 local). Ne lève JAMAIS : une échéance illisible qui ferait lever empêcherait toute
 * publication, c'est-à-dire exactement la fonction que ce lot livre. Calque de
 * `loadGscLatencyDays` (GSC-004).
 */
export async function loadPublishDeadlineMinutes(db: AppDb): Promise<number> {
	try {
		const res = await db.execute(sql`
			SELECT value FROM "seostats"."system_settings" WHERE key = ${PUBLISH_DEADLINE_KEY}
		`);
		const row = (res.rows ?? [])[0] as unknown as { value: string } | undefined;
		return resolvePublishDeadlineMinutes(row?.value ?? null);
	} catch (err) {
		logger.warn('échéance de publication illisible (défaut du code appliqué)', {
			error: err instanceof Error ? err.message : String(err)
		});
		return resolvePublishDeadlineMinutes(null);
	}
}

// ── L'état du créneau ───────────────────────────────────────────────

/**
 * Où en est chaque projet pour ce créneau : son run hebdo (s'il existe) et sa pause.
 *
 * ⚠️ Le run est cherché par `(run_type='weekly', period_end = créneau LOCAL)` — la clé que
 * `planOne` écrit (JOB-005), et non une fenêtre de dates. Chercher « le dernier run hebdo »
 * ferait passer le run de la semaine PRÉCÉDENTE pour celui du créneau le jour où la
 * planification échoue : le rapport se croirait prêt sur des steps vieux de sept jours.
 *
 * Deux requêtes, jamais une par projet : les projets, puis les runs du créneau, groupés en
 * mémoire (même discipline que `loadHomeCockpit`).
 */
export async function loadSlotReadiness(input: {
	db: AppDb;
	periodSlot: string;
	now: Date;
}): Promise<ProjectRunInput[]> {
	const [projects, runs, pauses] = await Promise.all([
		listSchedulableProjects(input.db),
		input.db
			.select({
				projectId: monitoringRuns.projectId,
				id: monitoringRuns.id,
				status: monitoringRuns.status
			})
			.from(monitoringRuns)
			.where(
				and(
					eq(monitoringRuns.runType, CADENCE_RUN_TYPE.weekly),
					eq(monitoringRuns.periodEnd, input.periodSlot)
				)
			),
		loadPauseStates(input.db, input.now)
	]);

	const runByProject = new Map(runs.map((r) => [r.projectId, r]));

	return projects.map((project) => {
		const run = runByProject.get(project.id) ?? null;
		// La MÊME autorité que le scheduler : `resolveCadencePause`. Recopier la règle d'union
		// des portées ferait diverger « ce qui n'a pas été planifié » et « ce qu'on n'attend
		// pas », et le rapport attendrait éternellement un run que personne ne produira.
		const pause = resolveCadencePause({
			states: pauses,
			projectId: project.id,
			cadence: 'weekly'
		});
		return {
			projectSlug: project.slug,
			runStatus: run?.status ?? null,
			runId: run?.id ?? null,
			paused: pause.paused,
			pauseReason: pause.by?.reason ?? null
		};
	});
}

// ── La publication ──────────────────────────────────────────────────

export interface PublishWeeklyReportResult {
	/** `no_slot` = la cadence hebdo ne produit aucun créneau (cadence désactivée). */
	action: PublicationDecision['action'] | 'no_slot';
	reason: PublicationReason | 'no_slot';
	periodSlot: string | null;
	status: PublicationStatus | null;
	/** Id de la ligne écrite, ou de celle qui existait déjà. `null` en attente. */
	reportId: string | null;
	slotAtDb: string | null;
	dueAtDb: string | null;
	/** Horodatage réellement écrit — la moitié du SLO. `null` si rien n'a été publié. */
	publishedAtDb: string | null;
	readiness: PublicationReadiness | null;
	slo: SloVerdict | null;
	/** Disponibilité et incidents, prêts à notifier (TEL-002). `null` en attente. */
	announcement: PublicationAnnouncement | null;
	/** N'a rien écrit (décision seule) : outillage et preuves. */
	dryRun: boolean;
}

export interface PublishWeeklyReportInput {
	db: AppDb;
	/**
	 * Référence de temps. Par défaut l'heure RÉELLE de l'appel, et non celle du début du tick :
	 * `published_at` est le fait « quand la ligne a été écrite », et un tick qui a drainé quatre
	 * minutes avant de publier ne doit pas s'attribuer une ponctualité qu'il n'a pas eue.
	 * Injectée par les tests et les preuves.
	 */
	now?: Date;
	/** Échéance forcée (minutes). À défaut, lue dans `system_settings`. */
	deadlineMinutes?: number;
	timeZone?: string;
	/** Ne rien écrire : rend la décision et s'arrête. */
	dryRun?: boolean;
	/**
	 * Créneau forcé. Réservé aux PREUVES : il permet d'exercer la publication sur un créneau
	 * synthétique (donc supprimable) sans toucher au rapport réel de la semaine. L'app ne le
	 * passe jamais — elle prend le créneau de l'horloge métier.
	 */
	slotOverride?: { periodSlot: string; slotAtMs: number };
}

/**
 * Publie le rapport du créneau courant, ou explique pourquoi il attend.
 *
 * Appelée à chaque tick horaire, et gratuite 167 heures sur 168 : quand la ligne du créneau
 * existe, la garde `alreadyPublished` sort avant toute lecture de runs et avant de construire
 * le rapport.
 *
 * Idempotence par la CONTRAINTE, pas par la lecture : `onConflictDoNothing` sur `period_slot`.
 * Deux ticks concurrents (Vercel ne le garantit pas, mais ne l'interdit pas) ne peuvent donc
 * pas écrire deux rapports pour le même lundi — le second récupère la ligne du premier et rend
 * `already_published`.
 */
export async function publishWeeklyReport(
	input: PublishWeeklyReportInput
): Promise<PublishWeeklyReportResult> {
	const db = input.db;
	const now = input.now ?? new Date();
	const dryRun = input.dryRun === true;

	const slot = input.slotOverride
		? { localSlot: input.slotOverride.periodSlot, instantMs: input.slotOverride.slotAtMs }
		: currentPublicationSlot({
				now,
				// Le spec du PARC, jamais un override projet : cf. `currentPublicationSlot`.
				spec: SCHEDULE_DEFAULTS.weekly,
				timeZone: input.timeZone
			});

	if (!slot) {
		return {
			action: 'no_slot',
			reason: 'no_slot',
			periodSlot: null,
			status: null,
			reportId: null,
			slotAtDb: null,
			dueAtDb: null,
			publishedAtDb: null,
			readiness: null,
			slo: null,
			announcement: null,
			dryRun
		};
	}

	const periodSlot = slot.localSlot;
	const slotAtDb = toDbTimestamp(new Date(slot.instantMs));

	// La garde la moins chère d'abord : une seule ligne lue, aucun run, aucun rapport construit.
	const existing = await db.query.weeklyReports.findFirst({
		where: eq(weeklyReports.periodSlot, periodSlot),
		columns: { id: true, status: true, dueAt: true, publishedAt: true }
	});

	const deadlineMinutes = input.deadlineMinutes ?? (await loadPublishDeadlineMinutes(db));

	if (existing) {
		// Le SLO de la ligne EXISTANTE, dérivé de ce qu'elle porte — pas de l'échéance
		// d'aujourd'hui, qui a pu changer entre-temps.
		return {
			action: 'already_published',
			reason: 'already_published',
			periodSlot,
			status: existing.status as PublicationStatus,
			reportId: existing.id,
			slotAtDb,
			dueAtDb: existing.dueAt,
			publishedAtDb: existing.publishedAt,
			readiness: null,
			slo: deriveSlo({
				slotAt: slotAtDb,
				dueAt: existing.dueAt,
				publishedAt: existing.publishedAt,
				parseMs: dbTimestampToMs
			}),
			announcement: null,
			dryRun
		};
	}

	const projects = await loadSlotReadiness({ db, periodSlot, now });
	const decision = decidePublication({
		periodSlot,
		slotAtMs: slot.instantMs,
		now,
		deadlineMinutes,
		projects,
		alreadyPublished: false
	});

	const dueAtDb = toDbTimestamp(new Date(decision.dueAtMs));

	if (decision.action !== 'publish') {
		logger.info('publication en attente', {
			periodSlot,
			reason: decision.reason,
			blockers: decision.readiness.blockers,
			dueAt: dueAtDb
		});
		return {
			action: decision.action,
			reason: decision.reason,
			periodSlot,
			status: null,
			reportId: null,
			slotAtDb,
			dueAtDb,
			publishedAtDb: null,
			readiness: decision.readiness,
			slo: null,
			announcement: null,
			dryRun
		};
	}

	// ⭐ Le rapport est construit sur le CRÉNEAU (`now: slot`), pas sur l'instant de
	// publication : la période couverte ne dépend donc pas de l'heure à laquelle le tick a
	// réussi à écrire.
	const report = await loadWeeklyReport({ db, now: new Date(slot.instantMs) });
	const publishedAtDb = toDbTimestamp(now);
	const slo = deriveSlo({
		slotAt: slotAtDb,
		dueAt: dueAtDb,
		publishedAt: publishedAtDb,
		parseMs: dbTimestampToMs
	});
	const announcement = renderPublicationAnnouncement({
		periodSlot,
		status: decision.status as PublicationStatus,
		slo,
		readiness: decision.readiness,
		headline: report.headline
	});

	if (dryRun) {
		return {
			action: 'publish',
			reason: decision.reason,
			periodSlot,
			status: decision.status,
			reportId: null,
			slotAtDb,
			dueAtDb,
			publishedAtDb,
			readiness: decision.readiness,
			slo,
			announcement,
			dryRun
		};
	}

	const id = createId();
	const inserted = await db
		.insert(weeklyReports)
		.values({
			id,
			periodSlot,
			status: decision.status as PublicationStatus,
			schemaVersion: PUBLICATION_SCHEMA_VERSION,
			reportSchemaVersion: REPORT_SCHEMA_VERSION,
			slotAt: slotAtDb,
			dueAt: dueAtDb,
			publishedAt: publishedAtDb,
			readinessJson: JSON.stringify(decision.readiness),
			payloadJson: JSON.stringify(report)
		})
		.onConflictDoNothing({ target: weeklyReports.periodSlot })
		.returning({ id: weeklyReports.id });

	if (!inserted[0]) {
		// Publication concurrente : la ligne de l'autre fait foi, on ne réécrit RIEN.
		const winner = await db.query.weeklyReports.findFirst({
			where: eq(weeklyReports.periodSlot, periodSlot),
			columns: { id: true, status: true, dueAt: true, publishedAt: true }
		});
		logger.warn('publication concurrente : la ligne existante fait foi', { periodSlot });
		return {
			action: 'already_published',
			reason: 'already_published',
			periodSlot,
			status: (winner?.status as PublicationStatus) ?? null,
			reportId: winner?.id ?? null,
			slotAtDb,
			dueAtDb: winner?.dueAt ?? dueAtDb,
			publishedAtDb: winner?.publishedAt ?? null,
			readiness: decision.readiness,
			slo: null,
			announcement: null,
			dryRun
		};
	}

	logger.info('rapport hebdomadaire publié', {
		periodSlot,
		status: decision.status,
		reason: decision.reason,
		sloMet: slo.met,
		lateMinutes: Math.round(slo.lateMs / 60000),
		expected: decision.readiness.expected,
		ready: decision.readiness.ready,
		degraded: decision.readiness.degraded,
		blockers: decision.readiness.blockers,
		paused: decision.readiness.paused,
		// Disponibilité et incidents : journalisés faute de canal (TEL-001 est BLOCKED).
		// Journalisés quand même, sinon la seule trace serait une ligne que personne ne lit.
		announcement: announcement.headline,
		incidents: decision.readiness.incidents.length
	});

	return {
		action: 'publish',
		reason: decision.reason,
		periodSlot,
		status: decision.status,
		reportId: inserted[0].id,
		slotAtDb,
		dueAtDb,
		publishedAtDb,
		readiness: decision.readiness,
		slo,
		announcement,
		dryRun
	};
}

// ── Lecture (« accessible après restart ») ──────────────────────────

export interface PublishedReportMeta {
	id: string;
	periodSlot: string;
	status: PublicationStatus;
	schemaVersion: number;
	reportSchemaVersion: number;
	slotAt: string;
	dueAt: string;
	publishedAt: string;
	readiness: PublicationReadiness | null;
	/** DÉRIVÉ à chaque lecture, jamais stocké. */
	slo: SloVerdict;
}

export interface PublishedReport extends PublishedReportMeta {
	report: WeeklyReport;
}

function toMeta(row: {
	id: string;
	periodSlot: string;
	status: string;
	schemaVersion: number;
	reportSchemaVersion: number;
	slotAt: string;
	dueAt: string;
	publishedAt: string;
	readinessJson: string;
}): PublishedReportMeta {
	let readiness: PublicationReadiness | null = null;
	try {
		readiness = JSON.parse(row.readinessJson) as PublicationReadiness;
	} catch {
		// Une préparation illisible ne doit pas rendre le rapport inaccessible : c'est le
		// PAYLOAD qui porte la valeur. L'absence se voit (`null`), elle ne se devine pas.
		readiness = null;
	}
	return {
		id: row.id,
		periodSlot: row.periodSlot,
		status: row.status as PublicationStatus,
		schemaVersion: row.schemaVersion,
		reportSchemaVersion: row.reportSchemaVersion,
		slotAt: row.slotAt,
		dueAt: row.dueAt,
		publishedAt: row.publishedAt,
		readiness,
		slo: deriveSlo({
			slotAt: row.slotAt,
			dueAt: row.dueAt,
			publishedAt: row.publishedAt,
			parseMs: dbTimestampToMs
		})
	};
}

/**
 * Les derniers rapports publiés, SANS leur payload.
 *
 * Le JSON d'un rapport pèse plusieurs dizaines de kilo-octets (jusqu'à 200 items par section) :
 * une liste qui les chargerait tous ferait payer à l'écran de listing le prix de douze rapports
 * complets pour n'afficher que douze dates. Le payload se lit à l'unité (`loadPublishedReport`).
 */
export async function listPublishedReports(input: {
	db?: AppDb;
	limit?: number;
}): Promise<PublishedReportMeta[]> {
	const db = await resolveDb(input.db);
	const rows = await db
		.select({
			id: weeklyReports.id,
			periodSlot: weeklyReports.periodSlot,
			status: weeklyReports.status,
			schemaVersion: weeklyReports.schemaVersion,
			reportSchemaVersion: weeklyReports.reportSchemaVersion,
			slotAt: weeklyReports.slotAt,
			dueAt: weeklyReports.dueAt,
			publishedAt: weeklyReports.publishedAt,
			readinessJson: weeklyReports.readinessJson
		})
		.from(weeklyReports)
		.orderBy(desc(weeklyReports.periodSlot))
		.limit(Math.max(1, Math.min(input.limit ?? 12, 100)));
	return rows.map(toMeta);
}

/**
 * Un rapport publié, payload compris. `periodSlot` absent = le plus récent.
 *
 * C'est l'acceptation « il reste accessible après restart » : aucune reconstruction, aucun
 * appel provider, aucune dépendance à l'état courant de la base — le JSON rendu est
 * exactement celui qui a été publié.
 *
 * Lève si le payload est illisible : un rapport archivé qu'on ne sait plus relire est une
 * anomalie à voir tout de suite, pas un `null` à interpréter comme « pas encore publié ».
 */
export async function loadPublishedReport(input: {
	db?: AppDb;
	periodSlot?: string;
}): Promise<PublishedReport | null> {
	const db = await resolveDb(input.db);
	const base = db
		.select({
			id: weeklyReports.id,
			periodSlot: weeklyReports.periodSlot,
			status: weeklyReports.status,
			schemaVersion: weeklyReports.schemaVersion,
			reportSchemaVersion: weeklyReports.reportSchemaVersion,
			slotAt: weeklyReports.slotAt,
			dueAt: weeklyReports.dueAt,
			publishedAt: weeklyReports.publishedAt,
			readinessJson: weeklyReports.readinessJson,
			payloadJson: weeklyReports.payloadJson
		})
		.from(weeklyReports);
	const rows = input.periodSlot
		? await base.where(eq(weeklyReports.periodSlot, input.periodSlot)).limit(1)
		: await base.orderBy(desc(weeklyReports.periodSlot)).limit(1);
	const row = rows[0];
	if (!row) return null;

	let report: WeeklyReport;
	try {
		report = JSON.parse(row.payloadJson) as WeeklyReport;
	} catch (err) {
		throw new Error(
			`Rapport ${row.periodSlot} illisible (payload_json corrompu) : ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}
	return { ...toMeta(row), report };
}
