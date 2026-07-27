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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
	deriveStatus,
	summarizeReadiness,
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
import { decideRevision, type RevisionRefusal } from './report-history-state.js';

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
	//
	// ⚠️ La révision COURANTE (numéro le plus haut), pas « une ligne du créneau » : depuis
	// REP-004 un créneau peut en porter plusieurs, et la garde doit répondre « ce créneau est
	// publié », pas « voici une de ses révisions ».
	const existing = await db.query.weeklyReports.findFirst({
		where: eq(weeklyReports.periodSlot, periodSlot),
		orderBy: [desc(weeklyReports.revision)],
		columns: { id: true, status: true, dueAt: true, publishedAt: true, revision: true }
	});

	const deadlineMinutes = input.deadlineMinutes ?? (await loadPublishDeadlineMinutes(db));

	if (existing) {
		// ⚠️ Le SLO est celui du CRÉNEAU, donc celui de sa PREMIÈRE publication — jamais celui
		// d'une révision. Une révision est un geste délibéré, écrit des heures ou des jours plus
		// tard : la mesurer contre l'échéance de 10:00 ferait passer une correction volontaire
		// pour un retard du cron, et réviser un créneau ponctuel dégraderait sa ponctualité
		// après coup. La lecture supplémentaire n'a lieu QUE s'il y a eu révision (167 ticks
		// sur 168 restent à une seule ligne lue).
		const firstPublishedAt =
			existing.revision === 1
				? existing.publishedAt
				: ((
						await db.query.weeklyReports.findFirst({
							where: eq(weeklyReports.periodSlot, periodSlot),
							orderBy: [asc(weeklyReports.revision)],
							columns: { publishedAt: true }
						})
					)?.publishedAt ?? existing.publishedAt);
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
				publishedAt: firstPublishedAt,
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
			payloadJson: JSON.stringify(report),
			// ⭐ Le chemin AUTOMATIQUE n'écrit QUE la révision 1, et c'est ce qui préserve
			// l'acceptation REP-003 après le déplacement de l'unique : un cron qui repasse cent
			// fois sur le même lundi produit toujours exactement une ligne. Une révision >= 2
			// n'existe que par un geste délibéré (`reviseWeeklyReport`) — sans cette asymétrie,
			// un tick instable réécrirait la semaine indéfiniment et l'histoire serait du bruit.
			revision: 1,
			revisionReason: null,
			supersedesId: null
		})
		.onConflictDoNothing({ target: [weeklyReports.periodSlot, weeklyReports.revision] })
		.returning({ id: weeklyReports.id });

	if (!inserted[0]) {
		// Publication concurrente : la ligne de l'autre fait foi, on ne réécrit RIEN.
		const winner = await db.query.weeklyReports.findFirst({
			where: eq(weeklyReports.periodSlot, periodSlot),
			orderBy: [desc(weeklyReports.revision)],
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

// ── REP-004 — La révision d'un créneau ──────────────────────────────

export interface ReviseWeeklyReportResult {
	action: 'revise' | 'refuse' | 'already_revised';
	/** `null` quand la révision a abouti. */
	refusal: RevisionRefusal | null;
	note: string | null;
	periodSlot: string;
	/** Numéro écrit (ou existant si course). `null` en cas de refus. */
	revision: number | null;
	reportId: string | null;
	/** L'id de la révision remplacée — elle reste intégralement lisible. */
	supersedesId: string | null;
	/** Statut de la NOUVELLE révision : c'est là qu'un `partial` peut devenir `complete`. */
	status: PublicationStatus | null;
	/** Statut de la révision précédente, pour lire le mouvement d'un coup d'œil. */
	previousStatus: PublicationStatus | null;
	readiness: PublicationReadiness | null;
	publishedAtDb: string | null;
	dryRun: boolean;
}

/**
 * Régénère le rapport d'un créneau DÉJÀ publié, en ajoutant une révision.
 *
 * C'est l'acceptation REP-004 « régénérer un rapport ne remplace pas silencieusement
 * l'original » : aucune ligne n'est modifiée, aucune n'est supprimée. La publication d'origine
 * garde son statut, son heure et son payload ; la révision est une ligne de plus, qui porte sa
 * raison. C'est aussi la seule réponse à la conséquence assumée de REP-003 — un `partial`
 * publié à l'échéance ne redevenait jamais `complete`, même quand la collecte finissait à 10:30.
 *
 * ⭐ **Le contenu est reconstruit sur le CRÉNEAU, pas sur maintenant.** `loadWeeklyReport`
 * reçoit `now = slot_at` (relu de la ligne d'origine, jamais recalculé) : la révision couvre
 * donc exactement la même semaine que ce qu'elle révise. Sans cette ancre, la révision de mardi
 * porterait une période décalée d'un jour, et comparer les deux révisions comparerait deux
 * semaines qui ne se recouvrent pas — la comparaison de REP-004 n'aurait alors plus de sujet.
 *
 * ⚠️ **Ni `slot_at` ni `due_at` ne sont recalculés** : ils sont recopiés de la révision 1.
 * `due_at` en particulier est le fait « ce qui avait été promis ce jour-là » — le recalculer
 * avec l'échéance d'aujourd'hui réécrirait après coup ce que le créneau devait tenir.
 *
 * Idempotence par la CONTRAINTE : `onConflictDoNothing` sur (period_slot, revision). Deux
 * révisions concurrentes n'en écrivent qu'une, la seconde rend `already_revised`.
 */
export async function reviseWeeklyReport(input: {
	db: AppDb;
	periodSlot: string;
	reason: string | null;
	/** Instant d'écriture. Injecté par les preuves ; l'app prend l'heure réelle. */
	now?: Date;
	dryRun?: boolean;
}): Promise<ReviseWeeklyReportResult> {
	const db = input.db;
	const now = input.now ?? new Date();
	const dryRun = input.dryRun === true;
	const periodSlot = input.periodSlot;

	const current = await db.query.weeklyReports.findFirst({
		where: eq(weeklyReports.periodSlot, periodSlot),
		orderBy: [desc(weeklyReports.revision)],
		columns: {
			id: true,
			revision: true,
			status: true,
			slotAt: true,
			dueAt: true,
			readinessJson: true
		}
	});

	const decision = decideRevision({
		current: current ? { id: current.id, revision: current.revision } : null,
		reason: input.reason
	});

	if (decision.action === 'refuse') {
		return {
			action: 'refuse',
			refusal: decision.refusal,
			note: decision.note,
			periodSlot,
			revision: null,
			reportId: null,
			supersedesId: null,
			status: null,
			previousStatus: (current?.status as PublicationStatus) ?? null,
			readiness: null,
			publishedAtDb: null,
			dryRun
		};
	}
	// `decideRevision` n'accepte que si `current` existe — TypeScript ne le déduit pas.
	if (!current) throw new Error('état impossible');

	const slotAtMs = dbTimestampToMs(current.slotAt);
	if (!Number.isFinite(slotAtMs)) {
		throw new Error(`slot_at illisible sur le créneau ${periodSlot} : ${current.slotAt}`);
	}

	// La préparation est recalculée MAINTENANT — c'est tout l'intérêt : les runs qui ont fini
	// entre-temps sont enfin comptés. Le périmètre, lui, reste celui du créneau.
	const deadlineMinutes = resolveDeadlineFromReadiness(current.readinessJson);
	const projects = await loadSlotReadiness({ db, periodSlot, now });
	const readiness = summarizeReadiness({ periodSlot, deadlineMinutes, projects });
	const status = deriveStatus(readiness);
	const report = await loadWeeklyReport({ db, now: new Date(slotAtMs) });
	const publishedAtDb = toDbTimestamp(now);

	if (dryRun) {
		return {
			action: 'revise',
			refusal: null,
			note: null,
			periodSlot,
			revision: decision.revision,
			reportId: null,
			supersedesId: decision.supersedesId,
			status,
			previousStatus: current.status as PublicationStatus,
			readiness,
			publishedAtDb,
			dryRun
		};
	}

	const id = createId();
	const inserted = await db
		.insert(weeklyReports)
		.values({
			id,
			periodSlot,
			status,
			schemaVersion: PUBLICATION_SCHEMA_VERSION,
			reportSchemaVersion: REPORT_SCHEMA_VERSION,
			// Recopiés, jamais recalculés : ce sont les faits du créneau, pas ceux d'aujourd'hui.
			slotAt: current.slotAt,
			dueAt: current.dueAt,
			publishedAt: publishedAtDb,
			readinessJson: JSON.stringify(readiness),
			payloadJson: JSON.stringify(report),
			revision: decision.revision,
			revisionReason: decision.reason,
			supersedesId: decision.supersedesId
		})
		.onConflictDoNothing({ target: [weeklyReports.periodSlot, weeklyReports.revision] })
		.returning({ id: weeklyReports.id });

	if (!inserted[0]) {
		logger.warn('révision concurrente : la ligne existante fait foi', {
			periodSlot,
			revision: decision.revision
		});
		return {
			action: 'already_revised',
			refusal: null,
			note: 'une révision portant ce numéro existe déjà : rien n’a été écrit.',
			periodSlot,
			revision: decision.revision,
			reportId: null,
			supersedesId: decision.supersedesId,
			status: null,
			previousStatus: current.status as PublicationStatus,
			readiness,
			publishedAtDb: null,
			dryRun
		};
	}

	logger.info('rapport hebdomadaire révisé', {
		periodSlot,
		revision: decision.revision,
		supersedes: decision.supersedesId,
		previousStatus: current.status,
		status,
		reason: decision.reason,
		expected: readiness.expected,
		ready: readiness.ready,
		blockers: readiness.blockers.length
	});

	return {
		action: 'revise',
		refusal: null,
		note: null,
		periodSlot,
		revision: decision.revision,
		reportId: inserted[0].id,
		supersedesId: decision.supersedesId,
		status,
		previousStatus: current.status as PublicationStatus,
		readiness,
		publishedAtDb,
		dryRun
	};
}

/**
 * L'échéance qui s'appliquait AU CRÉNEAU, relue dans sa préparation persistée.
 *
 * ⚠️ Surtout pas `loadPublishDeadlineMinutes` : ce réglage peut avoir changé depuis. La
 * révision doit décrire le périmètre du créneau avec les règles du créneau — sinon un
 * changement d'échéance réécrirait, dans le `readiness_json` d'une révision, une promesse qui
 * n'a jamais été faite. Défaut du code si la préparation est illisible (elle est déjà tolérée
 * `null` par `toMeta`).
 */
function resolveDeadlineFromReadiness(readinessJson: string): number {
	try {
		const parsed = JSON.parse(readinessJson) as PublicationReadiness;
		if (typeof parsed?.deadlineMinutes === 'number') return parsed.deadlineMinutes;
	} catch {
		// Une préparation illisible ne doit pas empêcher de réviser : c'est le PAYLOAD qui porte
		// la valeur du rapport.
	}
	return resolvePublishDeadlineMinutes(null);
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
	/** Écriture de CETTE révision. */
	publishedAt: string;
	/** REP-004 — numéro de révision de cette ligne. `1` = la publication automatique. */
	revision: number;
	/** `null` sur la révision 1. */
	revisionReason: string | null;
	supersedesId: string | null;
	/**
	 * Écriture de la PREMIÈRE publication du créneau — la moitié du SLO.
	 *
	 * ⚠️ Distinct de `publishedAt` dès qu'il y a eu révision, et c'est tout le sujet : le SLO
	 * mesure la ponctualité du cron sur le créneau, pas la date d'une correction volontaire.
	 */
	firstPublishedAt: string;
	/** Nombre de révisions existantes pour ce créneau (>= 1). */
	revisionCount: number;
	readiness: PublicationReadiness | null;
	/** DÉRIVÉ à chaque lecture, jamais stocké — sur `firstPublishedAt`. */
	slo: SloVerdict;
}

export interface PublishedReport extends PublishedReportMeta {
	report: WeeklyReport;
}

interface ReportRow {
	id: string;
	periodSlot: string;
	status: string;
	schemaVersion: number;
	reportSchemaVersion: number;
	slotAt: string;
	dueAt: string;
	publishedAt: string;
	readinessJson: string;
	revision: number;
	revisionReason: string | null;
	supersedesId: string | null;
}

/** Ce que le créneau porte AUTOUR de la ligne lue : sa première publication et son compte. */
interface SlotHistory {
	firstPublishedAt: string;
	revisionCount: number;
}

function toMeta(row: ReportRow, history?: SlotHistory): PublishedReportMeta {
	let readiness: PublicationReadiness | null = null;
	try {
		readiness = JSON.parse(row.readinessJson) as PublicationReadiness;
	} catch {
		// Une préparation illisible ne doit pas rendre le rapport inaccessible : c'est le
		// PAYLOAD qui porte la valeur. L'absence se voit (`null`), elle ne se devine pas.
		readiness = null;
	}
	// Sans histoire fournie, la ligne est sa propre origine : vrai par construction sur la
	// révision 1, et le seul repli honnête sur les autres (mieux vaut le SLO de la ligne lue
	// qu'un verdict inventé).
	const firstPublishedAt = history?.firstPublishedAt ?? row.publishedAt;
	return {
		id: row.id,
		periodSlot: row.periodSlot,
		status: row.status as PublicationStatus,
		schemaVersion: row.schemaVersion,
		reportSchemaVersion: row.reportSchemaVersion,
		slotAt: row.slotAt,
		dueAt: row.dueAt,
		publishedAt: row.publishedAt,
		revision: row.revision,
		revisionReason: row.revisionReason,
		supersedesId: row.supersedesId,
		firstPublishedAt,
		revisionCount: history?.revisionCount ?? 1,
		readiness,
		// ⚠️ Sur `firstPublishedAt`, pas sur `publishedAt` : le SLO est celui du CRÉNEAU. Une
		// révision écrite le mercredi ne dégrade pas la ponctualité du lundi, et ne la répare
		// pas non plus.
		slo: deriveSlo({
			slotAt: row.slotAt,
			dueAt: row.dueAt,
			publishedAt: firstPublishedAt,
			parseMs: dbTimestampToMs
		})
	};
}

/** Colonnes de lecture — `payload_json` EXCLU (plusieurs dizaines de kio par rapport). */
const META_COLUMNS = {
	id: weeklyReports.id,
	periodSlot: weeklyReports.periodSlot,
	status: weeklyReports.status,
	schemaVersion: weeklyReports.schemaVersion,
	reportSchemaVersion: weeklyReports.reportSchemaVersion,
	slotAt: weeklyReports.slotAt,
	dueAt: weeklyReports.dueAt,
	publishedAt: weeklyReports.publishedAt,
	readinessJson: weeklyReports.readinessJson,
	revision: weeklyReports.revision,
	revisionReason: weeklyReports.revisionReason,
	supersedesId: weeklyReports.supersedesId
} as const;

/**
 * L'histoire d'un ou plusieurs créneaux, en une requête.
 *
 * ⚠️ La première publication est celle de la RÉVISION 1, pas le `min(published_at)` du créneau :
 * les deux coïncident aujourd'hui, et divergeraient le jour où une révision serait écrite avec
 * une horloge décalée. Le repli sur `min` ne sert qu'au cas où la révision 1 aurait été purgée
 * (rétention, lot 2) — auquel cas la plus ancienne ligne restante est le meilleur fait
 * disponible, et il vaut mieux qu'un SLO absent.
 */
async function loadSlotHistories(db: AppDb, slots: readonly string[]): Promise<Map<string, SlotHistory>> {
	if (slots.length === 0) return new Map();
	const res = await db.execute(sql`
		SELECT period_slot,
		       COALESCE(min(published_at) FILTER (WHERE revision = 1), min(published_at)) AS first_published_at,
		       count(*)::int AS revision_count
		  FROM "seostats"."weekly_reports"
		 WHERE period_slot IN (${sql.join(
				slots.map((s) => sql`${s}`),
				sql`, `
			)})
		 GROUP BY period_slot
	`);
	const out = new Map<string, SlotHistory>();
	for (const raw of res.rows ?? []) {
		const row = raw as unknown as {
			period_slot: string;
			first_published_at: string;
			revision_count: number;
		};
		out.set(row.period_slot, {
			firstPublishedAt: row.first_published_at,
			revisionCount: Number(row.revision_count)
		});
	}
	return out;
}

/**
 * Les derniers créneaux publiés, SANS leur payload — un par créneau, sa révision COURANTE.
 *
 * Le JSON d'un rapport pèse plusieurs dizaines de kilo-octets (jusqu'à 200 items par section) :
 * une liste qui les chargerait tous ferait payer à l'écran de listing le prix de douze rapports
 * complets pour n'afficher que douze dates. Le payload se lit à l'unité (`loadPublishedReport`).
 *
 * ⚠️ `limit` compte des CRÉNEAUX, pas des lignes : depuis REP-004 un créneau peut en porter
 * plusieurs, et lire « les 12 dernières lignes » afficherait trois fois le même lundi le jour
 * où il aura été révisé deux fois.
 */
export async function listPublishedReports(input: {
	db?: AppDb;
	limit?: number;
}): Promise<PublishedReportMeta[]> {
	const db = await resolveDb(input.db);
	const limit = Math.max(1, Math.min(input.limit ?? 12, 100));

	// 1. Les créneaux (jamais les lignes), du plus récent au plus ancien. `period_slot` est
	//    lexicalement chronologique (`YYYY-MM-DDTHH:MM`), ce qui rend le tri exact sans parse.
	const slotRows = await db
		.select({ periodSlot: weeklyReports.periodSlot })
		.from(weeklyReports)
		.groupBy(weeklyReports.periodSlot)
		.orderBy(desc(weeklyReports.periodSlot))
		.limit(limit);
	const slots = slotRows.map((r) => r.periodSlot);
	if (slots.length === 0) return [];

	// 2. Toutes leurs révisions (peu nombreuses), et l'histoire de chaque créneau.
	const [rows, histories] = await Promise.all([
		db
			.select(META_COLUMNS)
			.from(weeklyReports)
			.where(inArray(weeklyReports.periodSlot, slots))
			.orderBy(desc(weeklyReports.periodSlot), desc(weeklyReports.revision)),
		loadSlotHistories(db, slots)
	]);

	// La révision courante = le numéro le plus haut. Le tri l'a placée en tête de son créneau.
	const seen = new Set<string>();
	const out: PublishedReportMeta[] = [];
	for (const row of rows) {
		if (seen.has(row.periodSlot)) continue;
		seen.add(row.periodSlot);
		out.push(toMeta(row, histories.get(row.periodSlot)));
	}
	return out;
}

/**
 * Le créneau publié juste AVANT celui-ci, ou `null` s'il n'y en a pas.
 *
 * ⚠️ « Le précédent » se prend sur le CRÉNEAU (`period_slot`), jamais sur `published_at` : un
 * rapport publié en retard reste celui de sa semaine, et trier par date d'écriture ferait
 * comparer deux fois la même semaine le jour où une publication rattrape la précédente.
 */
export async function findPreviousSlot(input: {
	db?: AppDb;
	periodSlot: string;
}): Promise<{ periodSlot: string; revision: number } | null> {
	const db = await resolveDb(input.db);
	const rows = await db
		.select({ periodSlot: weeklyReports.periodSlot, revision: weeklyReports.revision })
		.from(weeklyReports)
		.where(sql`${weeklyReports.periodSlot} < ${input.periodSlot}`)
		.orderBy(desc(weeklyReports.periodSlot), desc(weeklyReports.revision))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Toutes les révisions d'un créneau, de la plus ancienne à la plus récente, SANS payload.
 *
 * C'est la preuve lisible que « régénérer ne remplace pas » : l'original est là, avec son
 * statut d'origine et son heure d'origine.
 */
export async function listReportRevisions(input: {
	db?: AppDb;
	periodSlot: string;
}): Promise<PublishedReportMeta[]> {
	const db = await resolveDb(input.db);
	const [rows, histories] = await Promise.all([
		db
			.select(META_COLUMNS)
			.from(weeklyReports)
			.where(eq(weeklyReports.periodSlot, input.periodSlot))
			.orderBy(asc(weeklyReports.revision)),
		loadSlotHistories(db, [input.periodSlot])
	]);
	return rows.map((row) => toMeta(row, histories.get(row.periodSlot)));
}

/**
 * Un rapport publié, payload compris. `periodSlot` absent = le créneau le plus récent ;
 * `revision` absent = la révision COURANTE de ce créneau.
 *
 * C'est l'acceptation « il reste accessible après restart » : aucune reconstruction, aucun
 * appel provider, aucune dépendance à l'état courant de la base — le JSON rendu est
 * exactement celui qui a été publié. Et depuis REP-004, `revision` rend l'ORIGINAL d'un
 * créneau révisé tout aussi accessible : « ne remplace pas silencieusement » n'aurait aucun
 * sens si la ligne conservée n'était pas relisible.
 *
 * Lève si le payload est illisible : un rapport archivé qu'on ne sait plus relire est une
 * anomalie à voir tout de suite, pas un `null` à interpréter comme « pas encore publié ».
 */
export async function loadPublishedReport(input: {
	db?: AppDb;
	periodSlot?: string;
	revision?: number;
}): Promise<PublishedReport | null> {
	const db = await resolveDb(input.db);
	const columns = { ...META_COLUMNS, payloadJson: weeklyReports.payloadJson };

	// Sans créneau : le plus récent. Le tri porte sur (créneau, révision) — sans la seconde
	// clé, « le dernier rapport » aurait pu être une vieille révision du bon créneau.
	const where =
		input.periodSlot === undefined
			? undefined
			: input.revision === undefined
				? eq(weeklyReports.periodSlot, input.periodSlot)
				: and(
						eq(weeklyReports.periodSlot, input.periodSlot),
						eq(weeklyReports.revision, input.revision)
					);
	const query = db.select(columns).from(weeklyReports);
	const rows = await (where ? query.where(where) : query)
		.orderBy(desc(weeklyReports.periodSlot), desc(weeklyReports.revision))
		.limit(1);
	const row = rows[0];
	if (!row) return null;

	let report: WeeklyReport;
	try {
		report = JSON.parse(row.payloadJson) as WeeklyReport;
	} catch (err) {
		throw new Error(
			`Rapport ${row.periodSlot} (révision ${row.revision}) illisible (payload_json corrompu) : ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}
	const histories = await loadSlotHistories(db, [row.periodSlot]);
	return { ...toMeta(row, histories.get(row.periodSlot)), report };
}
