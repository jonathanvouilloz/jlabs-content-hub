/**
 * REP-004 lot 2 — Rétention du détail : la BASE.
 *
 * Le modèle pur vit dans `report-retention-state.ts` (testé par vitest) ; ici on lit les
 * candidats, on écrit la marque d'archivage APRÈS vérification, et on retire le payload.
 * Client drizzle INJECTÉ, comme partout depuis GSC-002.
 *
 * Trois gestes, dans cet ordre, et l'ordre est la garantie :
 *
 *   1. `listArchivableReports` — sortir le détail (le CLI l'écrit dans `.seo-data/`) ;
 *   2. `confirmReportArchived` — le RETROUVER dans le vault et comparer son empreinte ;
 *   3. `purgeReportDetails`    — retirer le payload des lignes que le plan autorise.
 *
 * ⚠️ **L'étape 2 n'est pas une formalité.** Sans elle, « on ne purge que ce qui est archivé »
 * ferait confiance à celui qui purge, et un rapport ne se régénère pas : REP-003 l'a construit
 * sur l'état du parc de ce créneau-là, et `loadWeeklyReport` répondrait aujourd'hui avec le parc
 * d'aujourd'hui. Une purge non couverte est une perte définitive.
 *
 * ⚠️ **La purge ré-assert ses conditions EN SQL**, en plus du plan et du CHECK. Un plan est une
 * photo : entre son calcul et son exécution, une ligne a pu être révisée ou déjà purgée. Le
 * `WHERE` refait donc le raisonnement au moment d'écrire.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { weeklyReports } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import { toDbTimestamp } from './timestamps.js';
import { measurePayload } from './report-publication.js';
import {
	deriveDetailState,
	resolveDetailRetentionWeeks,
	DETAIL_RETENTION_KEY,
	type DetailPurgePlan,
	type RetentionCandidate
} from './report-retention-state.js';

const logger = log('report-retention');

export { DETAIL_RETENTION_KEY };

// ── Le réglage (sans redéploiement) ─────────────────────────────────

/**
 * Lit la fenêtre de rétention du détail. Clé absente, JSON cassé, table vide → `null`, c'est-à-dire
 * **conserver sans limite**. Ne lève jamais : une fenêtre illisible qui ferait lever empêcherait
 * de lire un rapport, et une fenêtre illisible qui vaudrait « 4 semaines » purgerait sur un
 * malentendu. Calque de `loadGscLatencyDays` / `loadPublishDeadlineMinutes`.
 */
export async function loadDetailRetentionWeeks(db: AppDb): Promise<number | null> {
	try {
		const res = await db.execute(sql`
			SELECT value FROM "seostats"."system_settings" WHERE key = ${DETAIL_RETENTION_KEY}
		`);
		const row = (res.rows ?? [])[0] as unknown as { value: string } | undefined;
		return resolveDetailRetentionWeeks(row?.value ?? null);
	} catch (err) {
		logger.warn('fenêtre de rétention illisible (conservation sans limite appliquée)', {
			error: err instanceof Error ? err.message : String(err)
		});
		return null;
	}
}

/**
 * Écrit (ou efface) la fenêtre de rétention. Réservé à l'outillage : décider qu'un détail
 * disparaît au bout de N semaines est une décision d'exploitation, elle se prend à la main.
 */
export async function saveDetailRetentionWeeks(input: {
	db: AppDb;
	weeks: number | null;
	now?: Date | string;
}): Promise<void> {
	const nowDb = toDbTimestamp(input.now ?? new Date());
	const value =
		input.weeks === null ? JSON.stringify({ weeks: null }) : JSON.stringify({ weeks: input.weeks });
	await input.db.execute(sql`
		INSERT INTO "seostats"."system_settings" (key, value, description, updated_at)
		VALUES (
			${DETAIL_RETENTION_KEY},
			${value},
			${'Rétention du DÉTAIL des rapports hebdomadaires (semaines) — REP-004 lot 2. null = sans limite.'},
			${nowDb}
		)
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value,
		       description = EXCLUDED.description,
		       updated_at = EXCLUDED.updated_at
	`);
}

// ── Les candidats ───────────────────────────────────────────────────

/** Colonnes de rétention, sans le payload : de quoi décider sans charger 28 kio par ligne. */
const RETENTION_COLUMNS = {
	id: weeklyReports.id,
	periodSlot: weeklyReports.periodSlot,
	revision: weeklyReports.revision,
	slotAt: weeklyReports.slotAt,
	payloadBytes: weeklyReports.payloadBytes,
	payloadDigest: weeklyReports.payloadDigest,
	payloadArchivedAt: weeklyReports.payloadArchivedAt,
	payloadArchiveRef: weeklyReports.payloadArchiveRef,
	payloadPurgedAt: weeklyReports.payloadPurgedAt
} as const;

/**
 * Toutes les révisions publiées, avec l'état de leur détail — jamais le détail lui-même.
 *
 * ⚠️ **Toutes les révisions, pas les créneaux.** Deux révisions d'un même lundi portent deux
 * détails différents (c'est leur raison d'être) : archiver l'une ne couvre pas l'autre, et la
 * rétention se décide ligne par ligne.
 */
export async function listRetentionCandidates(db: AppDb): Promise<RetentionCandidate[]> {
	const rows = await db
		.select(RETENTION_COLUMNS)
		.from(weeklyReports)
		.orderBy(asc(weeklyReports.periodSlot), asc(weeklyReports.revision));
	return rows.map((row) => ({
		id: row.id,
		periodSlot: row.periodSlot,
		revision: row.revision,
		slotAt: row.slotAt,
		detail: deriveDetailState({
			hasPayload: row.payloadPurgedAt === null,
			payloadBytes: row.payloadBytes,
			payloadDigest: row.payloadDigest,
			payloadArchivedAt: row.payloadArchivedAt,
			payloadArchiveRef: row.payloadArchiveRef,
			payloadPurgedAt: row.payloadPurgedAt
		})
	}));
}

// ── 1. L'export ─────────────────────────────────────────────────────

export interface ArchivableReport {
	id: string;
	periodSlot: string;
	revision: number;
	/** Le `payload_json` **tel quel** : c'est lui qu'on écrit sur disque, octet pour octet. */
	payloadJson: string;
	/** L'empreinte publiée. `null` sur une ligne écrite avant REP-004 lot 2. */
	digest: string | null;
	archivedAt: string | null;
	archiveRef: string | null;
}

/**
 * Les révisions dont le détail est encore en base — celles qu'on peut sortir vers le vault.
 *
 * `onlyUnarchived` (défaut `true`) saute celles qui portent déjà leur adresse : ré-exporter un
 * détail déjà archivé produirait un fichier identique et une seconde note dans le vault, que
 * `/seo-archive` sauterait de toute façon par son `content_hash`.
 */
export async function listArchivableReports(input: {
	db: AppDb;
	periodSlot?: string;
	revision?: number;
	onlyUnarchived?: boolean;
}): Promise<ArchivableReport[]> {
	const filters = [isNotNull(weeklyReports.payloadJson)];
	if (input.periodSlot !== undefined) filters.push(eq(weeklyReports.periodSlot, input.periodSlot));
	if (input.revision !== undefined) filters.push(eq(weeklyReports.revision, input.revision));
	if (input.onlyUnarchived !== false) filters.push(isNull(weeklyReports.payloadArchivedAt));

	const rows = await input.db
		.select({
			id: weeklyReports.id,
			periodSlot: weeklyReports.periodSlot,
			revision: weeklyReports.revision,
			payloadJson: weeklyReports.payloadJson,
			payloadDigest: weeklyReports.payloadDigest,
			payloadArchivedAt: weeklyReports.payloadArchivedAt,
			payloadArchiveRef: weeklyReports.payloadArchiveRef
		})
		.from(weeklyReports)
		.where(and(...filters))
		.orderBy(desc(weeklyReports.periodSlot), desc(weeklyReports.revision));

	return rows.map((row) => ({
		id: row.id,
		periodSlot: row.periodSlot,
		revision: row.revision,
		// `payloadJson` est non-null par le filtre ; TypeScript ne le déduit pas du `where`.
		payloadJson: row.payloadJson as string,
		digest: row.payloadDigest,
		archivedAt: row.payloadArchivedAt,
		archiveRef: row.payloadArchiveRef
	}));
}

// ── 2. La confirmation d'archivage (vérifiée) ───────────────────────

export type ArchiveConfirmation =
	| {
			action: 'confirmed';
			id: string;
			digest: string;
			archiveRef: string;
			archivedAt: string;
	  }
	| {
			action: 'already_archived';
			id: string;
			archiveRef: string;
			archivedAt: string;
	  }
	| {
			action: 'refused';
			reason: 'not_found' | 'purged' | 'digest_mismatch';
			note: string;
	  };

/**
 * Marque une révision comme archivée — **après** avoir comparé l'empreinte fournie à celle du
 * détail en base.
 *
 * ⭐ **C'est ici que « archivé » cesse d'être une déclaration.** L'appelant a lu un fichier dans
 * le vault et en a calculé le SHA-256 ; si ce hash ne correspond pas au détail de cette ligne,
 * le fichier est peut-être un autre rapport, une autre révision, ou une copie tronquée — et la
 * purge qui suivrait détruirait l'original sur la foi d'un homonyme.
 *
 * ⚠️ Une ligne écrite avant lot 2 n'a pas d'empreinte publiée : on la calcule alors depuis le
 * payload en base (donc sur la chaîne exacte), et on la persiste au passage. Le CHECK exigera
 * `payload_digest` au moment de purger ; la remplir ici évite une purge impossible plus tard.
 */
export async function confirmReportArchived(input: {
	db: AppDb;
	periodSlot: string;
	revision: number;
	/** SHA-256 du fichier retrouvé dans le vault. */
	fileDigest: string;
	/** Chemin de l'archive, relatif au vault. */
	archiveRef: string;
	now?: Date;
	force?: boolean;
}): Promise<ArchiveConfirmation> {
	const db = input.db;
	const row = await db.query.weeklyReports.findFirst({
		where: and(
			eq(weeklyReports.periodSlot, input.periodSlot),
			eq(weeklyReports.revision, input.revision)
		),
		columns: {
			id: true,
			payloadJson: true,
			payloadDigest: true,
			payloadArchivedAt: true,
			payloadArchiveRef: true,
			payloadPurgedAt: true
		}
	});

	if (!row) {
		return {
			action: 'refused',
			reason: 'not_found',
			note: `Aucune révision ${input.revision} pour le créneau ${input.periodSlot}.`
		};
	}
	if (row.payloadJson === null) {
		return {
			action: 'refused',
			reason: 'purged',
			note: `Le détail de ${input.periodSlot} (rév. ${input.revision}) est déjà purgé : il n’y a plus rien à comparer. Son archive est « ${row.payloadArchiveRef ?? '∅'} ».`
		};
	}
	if (row.payloadArchivedAt && row.payloadArchiveRef && input.force !== true) {
		return {
			action: 'already_archived',
			id: row.id,
			archiveRef: row.payloadArchiveRef,
			archivedAt: row.payloadArchivedAt
		};
	}

	// L'empreinte de référence : celle publiée, ou celle du payload en base pour les lignes
	// antérieures au lot 2. Jamais celle du fichier — ce serait se vérifier soi-même.
	const digest = row.payloadDigest ?? measurePayload(row.payloadJson).digest;
	if (digest !== input.fileDigest) {
		return {
			action: 'refused',
			reason: 'digest_mismatch',
			note: `L’archive ne correspond pas à ce rapport : attendu ${digest.slice(0, 12)}…, fichier ${input.fileDigest.slice(0, 12)}…. Rien n’est marqué comme archivé — une purge sur cette base détruirait l’original.`
		};
	}

	const nowDb = toDbTimestamp(input.now ?? new Date());
	const measured = measurePayload(row.payloadJson);
	await db
		.update(weeklyReports)
		.set({
			payloadArchivedAt: nowDb,
			payloadArchiveRef: input.archiveRef,
			payloadDigest: digest,
			payloadBytes: measured.bytes
		})
		.where(eq(weeklyReports.id, row.id));

	logger.info('détail de rapport archivé (empreinte vérifiée)', {
		periodSlot: input.periodSlot,
		revision: input.revision,
		archiveRef: input.archiveRef,
		bytes: measured.bytes
	});

	return {
		action: 'confirmed',
		id: row.id,
		digest,
		archiveRef: input.archiveRef,
		archivedAt: nowDb
	};
}

// ── 3. La purge ─────────────────────────────────────────────────────

export interface PurgeOutcome {
	purged: number;
	skipped: number;
	bytesFreed: number;
	ids: string[];
	dryRun: boolean;
}

/**
 * Retire le `payload_json` des lignes que le plan autorise. **Aucune ligne n'est supprimée.**
 *
 * ⚠️ Le `WHERE` REFAIT le raisonnement du plan (détail présent, archive posée, empreinte
 * connue) : un plan est une photo, et entre son calcul et son exécution une ligne a pu être
 * archivée ailleurs, révisée, ou déjà purgée. Une purge qui ne ré-assert rien ferait de chaque
 * seconde d'écart une fenêtre de perte.
 */
export async function purgeReportDetails(input: {
	db: AppDb;
	plan: DetailPurgePlan;
	now?: Date;
	dryRun?: boolean;
}): Promise<PurgeOutcome> {
	const dryRun = input.dryRun !== false;
	const nowDb = toDbTimestamp(input.now ?? new Date());
	const targets = input.plan.purge;

	if (dryRun || targets.length === 0) {
		return {
			purged: 0,
			skipped: targets.length,
			bytesFreed: 0,
			ids: targets.map((t) => t.id),
			dryRun
		};
	}

	const ids: string[] = [];
	let bytesFreed = 0;
	for (const target of targets) {
		const updated = await input.db
			.update(weeklyReports)
			.set({ payloadJson: null, payloadPurgedAt: nowDb })
			.where(
				and(
					eq(weeklyReports.id, target.id),
					isNotNull(weeklyReports.payloadJson),
					isNotNull(weeklyReports.payloadArchivedAt),
					isNotNull(weeklyReports.payloadArchiveRef),
					isNotNull(weeklyReports.payloadDigest)
				)
			)
			.returning({ id: weeklyReports.id, bytes: weeklyReports.payloadBytes });
		if (updated[0]) {
			ids.push(updated[0].id);
			bytesFreed += updated[0].bytes ?? 0;
		}
	}

	logger.info('détails de rapports purgés', {
		purged: ids.length,
		planned: targets.length,
		bytesFreed,
		retentionWeeks: input.plan.retentionWeeks
	});

	return {
		purged: ids.length,
		skipped: targets.length - ids.length,
		bytesFreed,
		ids,
		dryRun
	};
}
