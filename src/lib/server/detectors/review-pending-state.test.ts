import { describe, it, expect } from 'vitest';
import {
	DETECTOR_REVIEW_PENDING,
	NEGATIVE_REVIEW_SKILL,
	NEGATIVE_REVIEW_TYPE,
	NOTIFY_IMMEDIATELY_REASON,
	REVIEW_PENDING_DEFAULTS,
	REVIEW_PENDING_SLA_SKILL,
	REVIEW_PENDING_SLA_TYPE,
	buildReviewEvidence,
	buildReviewTitle,
	computeReviewConfidence,
	decideLocationScope,
	deriveReviewSeverity,
	parseReviewCreateTime,
	resolveReviewPendingThresholds,
	reviewAgeDays,
	reviewFingerprint,
	reviewSinceBound,
	reviewSkill,
	runReviewPendingPass,
	scoreReviewUnit,
	selectByLocation,
	shouldNotifyImmediately,
	type LocationBacklog,
	type LocationHealth,
	type ReviewPendingPassResult,
	type ReviewRow,
	type ReviewUnit
} from './review-pending-state.js';
import { computePriorityScore } from '../finding-state.js';
import { toDbTimestamp } from '../timestamps.js';

const T = resolveReviewPendingThresholds();
const NOW = new Date('2026-07-28T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** Un instant ISO (forme Google) à J-`days`. */
function isoDaysAgo(days: number, hour = 10): string {
	const d = new Date(NOW.getTime() - days * DAY);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}

/** Un instant au format DB (forme hub) à J-`days`. */
function dbDaysAgo(days: number, hours = 0): string {
	return toDbTimestamp(new Date(NOW.getTime() - days * DAY - hours * 3_600_000));
}

const FRESH_LOCATION: LocationHealth = {
	locationId: 'loc-a',
	label: 'Barber Concept Eaux Vives',
	lastSyncAt: dbDaysAgo(0, 2),
	lastSyncStatus: 'success'
};

function review(over: Partial<ReviewRow> = {}): ReviewRow {
	return {
		reviewId: 'rev-1',
		locationId: 'loc-a',
		locationLabel: 'Barber Concept Eaux Vives',
		rating: 5,
		createTime: isoDaysAgo(20),
		repliedAt: null,
		remoteReplyAt: null,
		lastSeenAt: dbDaysAgo(0, 1),
		hasDraft: false,
		...over
	};
}

function pass(input: {
	reviews: ReviewRow[];
	locations?: LocationHealth[];
	backlog?: LocationBacklog[];
	thresholds?: Partial<typeof REVIEW_PENDING_DEFAULTS>;
}): ReviewPendingPassResult {
	const locations = input.locations ?? [FRESH_LOCATION];
	return runReviewPendingPass({
		reviews: input.reviews,
		locations,
		backlog: input.backlog ?? locations.map((l) => ({ locationId: l.locationId, total: 100, pending: 10 })),
		thresholds: resolveReviewPendingThresholds(input.thresholds ?? null),
		now: NOW
	});
}

const keys = (units: ReviewUnit[]) => units.map((u) => u.reviewId).sort();

// ── Seuils ──────────────────────────────────────────────────────────

describe('resolveReviewPendingThresholds — les défauts portent le dimensionnement du lot', () => {
	it('le SLA est à 3 jours et la fenêtre à 180 jours', () => {
		// 180 j est CE QUI garde les 332 avis d'avant 2025 hors alerte tout en les laissant visibles.
		expect(T.slaDays).toBe(3);
		expect(T.slaLookbackDays).toBe(180);
		expect(T.maxCandidates).toBe(30);
	});

	it('§10.4 (note 1–3) et §14.3 (notification 1–2) restent DEUX seuils distincts', () => {
		expect(T.negativeRatingMax).toBe(3);
		expect(T.notifyRatingMax).toBe(2);
	});

	it('un override corrompu retombe sur le défaut, jamais sur une garde désarmée', () => {
		const r = resolveReviewPendingThresholds({
			slaDays: 0,
			slaLookbackDays: -1,
			maxCandidates: Number.NaN,
			syncFreshnessHours: '48' as unknown as number
		});
		expect(r.slaDays).toBe(T.slaDays);
		expect(r.slaLookbackDays).toBe(T.slaLookbackDays);
		expect(r.maxCandidates).toBe(T.maxCandidates);
		expect(r.syncFreshnessHours).toBe(T.syncFreshnessHours);
	});

	it('un override légitime est appliqué', () => {
		const r = resolveReviewPendingThresholds({ slaDays: 7, maxCandidates: 5 });
		expect(r.slaDays).toBe(7);
		expect(r.maxCandidates).toBe(5);
	});

	it('un seuil de note à 9 est BORNÉ à 5 — sinon tout avis deviendrait négatif', () => {
		// Valeur finie, entière et ≥ 1 : le filtre générique la laisserait passer.
		const r = resolveReviewPendingThresholds({ negativeRatingMax: 9, notifyRatingMax: 9 });
		expect(r.negativeRatingMax).toBe(5);
		expect(r.notifyRatingMax).toBe(5);
	});
});

describe('skills — §10.4 donne DEUX gestes, pas un', () => {
	it('le SLA route vers le rédacteur de réponse, le négatif n’a PAS de skill', () => {
		expect(reviewSkill(REVIEW_PENDING_SLA_TYPE)).toBe(REVIEW_PENDING_SLA_SKILL);
		expect(reviewSkill(NEGATIVE_REVIEW_TYPE)).toBeNull();
		expect(NEGATIVE_REVIEW_SKILL).toBeNull();
	});
});

// ── Horodatage : la garde du format mixte ───────────────────────────

describe('parseReviewCreateTime — ISO Google et format DB rendent le MÊME instant', () => {
	it('lit les deux formes sans jamais les comparer lexicalement', () => {
		const iso = parseReviewCreateTime('2026-07-18T10:52:48.406099Z');
		const db = parseReviewCreateTime('2026-07-18 10:52:48');
		expect(iso).not.toBeNull();
		expect(db).not.toBeNull();
		// Les microsecondes de Google sont la seule différence tolérée.
		expect(Math.abs((iso as number) - (db as number))).toBeLessThan(1000);
	});

	it('le format DB est lu en UTC, pas en heure locale', () => {
		expect(parseReviewCreateTime('2026-07-18 10:52:48')).toBe(Date.parse('2026-07-18T10:52:48Z'));
	});

	it('une date nue est lue à minuit UTC', () => {
		expect(parseReviewCreateTime('2026-07-18')).toBe(Date.parse('2026-07-18T00:00:00Z'));
	});

	it('une valeur illisible rend null — jamais une date inventée', () => {
		expect(parseReviewCreateTime(null)).toBeNull();
		expect(parseReviewCreateTime('')).toBeNull();
		expect(parseReviewCreateTime('bientôt')).toBeNull();
	});
});

describe('reviewSinceBound — la borne SQL est une DATE NUE', () => {
	it('rend YYYY-MM-DD', () => {
		expect(reviewSinceBound(NOW, 180)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(reviewSinceBound(NOW, 0)).toBe('2026-07-28');
	});

	it('la borne est un préfixe VALIDE des deux formes du jour de bord', () => {
		// C'est toute la raison de la date nue : les deux comparaisons doivent être vraies.
		const bound = reviewSinceBound(NOW, 0);
		expect('2026-07-28T03:00:00Z' >= bound).toBe(true);
		expect('2026-07-28 03:00:00' >= bound).toBe(true);
	});

	it('régression weekly-report.ts:148 — deux avis du même jour se départagent sur l’INSTANT', () => {
		// Comparé lexicalement à une borne au format DB, `'…T23:00:00Z'` passait toujours parce que
		// 'T' (0x54) > ' ' (0x20) à l'index 10 : tout avis du jour comptait comme récent.
		const bound = Date.parse('2026-07-18T12:00:00Z');
		const early = parseReviewCreateTime('2026-07-18 03:00:00') as number;
		const late = parseReviewCreateTime('2026-07-18T23:00:00Z') as number;
		expect(early >= bound).toBe(false);
		expect(late >= bound).toBe(true);
		// Le piège inverse, lexical, aurait dit « les deux ».
		expect('2026-07-18 03:00:00' >= '2026-07-18 12:00:00').toBe(false);
		expect('2026-07-18T23:00:00Z' >= '2026-07-18 12:00:00').toBe(true);
	});

	it('reviewAgeDays ne rend jamais un âge négatif', () => {
		expect(reviewAgeDays(NOW.getTime() + DAY, NOW.getTime())).toBe(0);
		expect(reviewAgeDays(NOW.getTime() - 3 * DAY, NOW.getTime())).toBe(3);
	});
});

// ── Portée d'une fiche ──────────────────────────────────────────────

describe('decideLocationScope — succès ET fraîcheur, jamais l’un sans l’autre', () => {
	const nowMs = NOW.getTime();

	it('une fiche jamais synchronisée n’est pas dans la portée', () => {
		const v = decideLocationScope({
			health: { ...FRESH_LOCATION, lastSyncAt: null, lastSyncStatus: null },
			nowMs,
			freshnessHours: T.syncFreshnessHours
		});
		expect(v.fresh).toBe(false);
		expect(v.reason).toBe('never_synced');
	});

	it('une fiche en ERREUR mais fraîche n’est pas dans la portée', () => {
		// Le collecteur écrit `last_sync_at` AUSSI en cas d'échec : la date seule mentirait.
		const v = decideLocationScope({
			health: { ...FRESH_LOCATION, lastSyncStatus: 'error' },
			nowMs,
			freshnessHours: T.syncFreshnessHours
		});
		expect(v.fresh).toBe(false);
		expect(v.reason).toBe('sync_error');
	});

	it('une fiche en succès mais périmée n’est pas dans la portée', () => {
		const v = decideLocationScope({
			health: { ...FRESH_LOCATION, lastSyncAt: dbDaysAgo(3) },
			nowMs,
			freshnessHours: T.syncFreshnessHours
		});
		expect(v.fresh).toBe(false);
		expect(v.reason).toBe('stale');
	});

	it('succès + fraîcheur ⇒ dans la portée', () => {
		const v = decideLocationScope({ health: FRESH_LOCATION, nowMs, freshnessHours: T.syncFreshnessHours });
		expect(v.fresh).toBe(true);
		expect(v.reason).toBeNull();
	});
});

// ── Portée : ce que le run laisse strictement intact ────────────────

describe('portée du run — un avis hors portée n’entre ni dans une closure ni dans un scope', () => {
	it('une fiche en erreur sort TOUS ses avis de la portée', () => {
		const r = pass({
			reviews: [review({ rating: 1 })],
			locations: [{ ...FRESH_LOCATION, lastSyncStatus: 'error' }]
		});
		expect(r.staleLocation).toBe(1);
		expect(r.scopeSla.size).toBe(0);
		expect(r.scopeNegative.size).toBe(0);
		expect(r.sla.matched).toHaveLength(0);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('`last_seen_at IS NULL` ⇒ hors scope ET hors closure (les 88 lignes du backfill)', () => {
		const r = pass({ reviews: [review({ rating: 1, lastSeenAt: null })] });
		expect(r.neverSeen).toBe(1);
		expect(r.scopeNegative.size).toBe(0);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('vu AVANT la dernière synchro réussie ⇒ disparu chez Google, laissé intact', () => {
		const r = pass({ reviews: [review({ rating: 1, lastSeenAt: dbDaysAgo(5) })] });
		expect(r.vanished).toBe(1);
		expect(r.scopeNegative.size).toBe(0);
	});

	it('un avis à J-200 est hors scope SLA mais DANS le scope négatif', () => {
		// Les deux fenêtres diffèrent, donc les deux portées aussi — c'est ce qui empêche le
		// glissement de fenêtre d'auto-résoudre.
		const r = pass({ reviews: [review({ rating: 5, createTime: isoDaysAgo(200) })] });
		expect(r.inScopeSla).toBe(0);
		expect(r.inScopeNegative).toBe(1);
		expect(r.scopeSla.size).toBe(0);
		expect(r.scopeNegative.size).toBe(1);
	});

	it('au-delà des DEUX fenêtres, l’avis est compté hors fenêtre et laissé intact', () => {
		const r = pass({ reviews: [review({ rating: 1, createTime: isoDaysAgo(400) })] });
		expect(r.outOfWindow).toBe(1);
		expect(r.scopeSla.size + r.scopeNegative.size).toBe(0);
	});

	it('un avis répondu reste DANS la portée — c’est ce qui permet l’auto-résolution', () => {
		const r = pass({ reviews: [review({ rating: 1, remoteReplyAt: dbDaysAgo(1) })] });
		expect(r.answered).toBe(1);
		expect(r.scopeSla.size).toBe(1);
		expect(r.scopeNegative.size).toBe(1);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('un 5★ reste dans le scope NÉGATIF — une note qui remonte doit pouvoir se résoudre', () => {
		const r = pass({ reviews: [review({ rating: 5 })] });
		expect(r.scopeNegative.size).toBe(1);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('invariant : chaque closure est INCLUSE dans son scope', () => {
		const reviews: ReviewRow[] = [];
		for (let i = 0; i < 200; i += 1) {
			reviews.push(
				review({
					reviewId: `rev-${i}`,
					rating: (i % 5) + 1,
					createTime: isoDaysAgo(i * 2),
					remoteReplyAt: i % 3 === 0 ? dbDaysAgo(1) : null,
					lastSeenAt: i % 17 === 0 ? null : dbDaysAgo(0, 1)
				})
			);
		}
		const r = pass({ reviews });
		for (const u of r.sla.matched) expect(r.scopeSla.has(u.fingerprint)).toBe(true);
		for (const u of r.negative.matched) expect(r.scopeNegative.has(u.fingerprint)).toBe(true);
	});
});

// ── Closure : ce que le run dénonce ─────────────────────────────────

describe('closure — l’âge fait le SLA, la note fait le négatif', () => {
	it('un 5★ d’un jour ne produit rien', () => {
		const r = pass({ reviews: [review({ rating: 5, createTime: isoDaysAgo(1) })] });
		expect(r.sla.matched).toHaveLength(0);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('un 5★ de 20 jours produit le SLA seul', () => {
		const r = pass({ reviews: [review({ rating: 5, createTime: isoDaysAgo(20) })] });
		expect(r.sla.matched).toHaveLength(1);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('un 2★ d’un jour produit le négatif seul — sa confirmation est « immédiat »', () => {
		const r = pass({ reviews: [review({ rating: 2, createTime: isoDaysAgo(1) })] });
		expect(r.sla.matched).toHaveLength(0);
		expect(r.negative.matched).toHaveLength(1);
	});

	it('un 2★ de 20 jours produit LES DEUX, avec des fingerprints distincts', () => {
		// La décision centrale du lot : deux gestes différents, donc deux findings.
		const r = pass({ reviews: [review({ rating: 2, createTime: isoDaysAgo(20) })] });
		expect(r.sla.matched).toHaveLength(1);
		expect(r.negative.matched).toHaveLength(1);
		expect(r.sla.matched[0].fingerprint).not.toBe(r.negative.matched[0].fingerprint);
		expect(r.sla.matched[0].reviewId).toBe(r.negative.matched[0].reviewId);
	});

	it('un 3★ est négatif (§10.4) mais NON notifiable (§14.3)', () => {
		const r = pass({ reviews: [review({ rating: 3, createTime: isoDaysAgo(1) })] });
		expect(r.negative.matched).toHaveLength(1);
		expect(r.negative.matched[0].notifyImmediately).toBe(false);
	});

	it('`rating = 0` est illisible : exclu et COMPTÉ, jamais le pire avis du parc', () => {
		const r = pass({ reviews: [review({ rating: 0 })] });
		expect(r.unreadableRating).toBe(1);
		expect(r.negative.matched).toHaveLength(0);
		expect(r.scopeNegative.size).toBe(0);
	});

	it('un `create_time` illisible est compté, jamais deviné', () => {
		const r = pass({ reviews: [review({ rating: 1, createTime: 'la semaine dernière' })] });
		expect(r.unreadableCreateTime).toBe(1);
		expect(r.negative.matched).toHaveLength(0);
	});

	it('répondu LOCALEMENT ⇒ hors closure', () => {
		const r = pass({ reviews: [review({ rating: 1, repliedAt: dbDaysAgo(1), remoteReplyAt: dbDaysAgo(1) })] });
		expect(r.negative.matched).toHaveLength(0);
	});

	it('la divergence GMB-007 est COMPTÉE, jamais transformée en finding', () => {
		// `replied_at` renseigné, `remote_reply_at` vide : le hub croit avoir répondu, Google ne le
		// confirme pas. Rouvrir la file produirait une SECONDE réponse au même client.
		const r = pass({ reviews: [review({ rating: 1, repliedAt: dbDaysAgo(1) })] });
		expect(r.divergent).toBe(1);
		expect(r.answered).toBe(1);
		expect(r.negative.matched).toHaveLength(0);
		expect(r.sla.matched).toHaveLength(0);
	});
});

// ── Troncature et tour d'équité ─────────────────────────────────────

describe('selectByLocation — le plafond ne doit jamais faire taire une fiche entière', () => {
	function unit(id: string, locationId: string, priorityScore: number): ReviewUnit {
		return {
			type: NEGATIVE_REVIEW_TYPE,
			fingerprint: reviewFingerprint(NEGATIVE_REVIEW_TYPE, id, locationId),
			reviewId: id,
			locationId,
			locationLabel: locationId,
			rating: 2,
			createdAtRaw: isoDaysAgo(5),
			createdAtDb: dbDaysAgo(5),
			createdDate: '2026-07-23',
			ageDays: 5,
			overdueBy: 2,
			slaBreached: true,
			hasDraft: false,
			backlog: { pending: 1, total: 1, share: 1 },
			health: { lastSyncAt: null, lastSyncStatus: 'success', hoursSinceSync: 1 },
			lastSeenAt: dbDaysAgo(0, 1),
			confidenceScore: 90,
			confidenceCaveats: [],
			score: { impact: 10, urgency: 10, confidence: 10, strategicFit: 10 },
			priorityScore,
			severity: 'high',
			notifyImmediately: true
		};
	}

	it('30 places sur 100 candidats : chaque fiche est représentée', () => {
		const units: ReviewUnit[] = [];
		// Une fiche écrasante (Eaux Vives) et cinq petites — la répartition mesurée en prod.
		for (let i = 0; i < 70; i += 1) units.push(unit(`big-${i}`, 'loc-big', 100 - i * 0.1));
		for (let l = 0; l < 5; l += 1) {
			for (let i = 0; i < 6; i += 1) units.push(unit(`s${l}-${i}`, `loc-${l}`, 40 - i));
		}
		const sel = selectByLocation(units, 30);
		expect(sel.units).toHaveLength(30);
		expect(sel.totalMatched).toBe(100);
		expect(sel.truncated).toBe(true);
		const locations = new Set(sel.units.map((u) => u.locationId));
		expect(locations.size).toBe(6);
	});

	it('la closure porte les 100 — le tour d’équité ne ferme RIEN', () => {
		const units = Array.from({ length: 100 }, (_, i) => unit(`r-${i}`, 'loc-big', 100 - i));
		const sel = selectByLocation(units, 30);
		expect(sel.matched).toHaveLength(100);
		expect(sel.units).toHaveLength(30);
	});

	it('la petite fiche garde une place face à une fiche 10× plus grosse', () => {
		const units = [
			...Array.from({ length: 30 }, (_, i) => unit(`big-${i}`, 'loc-big', 99 - i)),
			...Array.from({ length: 3 }, (_, i) => unit(`small-${i}`, 'loc-small', 10 - i))
		];
		const sel = selectByLocation(units, 10);
		expect(sel.units.filter((u) => u.locationId === 'loc-small').length).toBeGreaterThanOrEqual(1);
	});

	it('déterministe : un jeu mélangé rend exactement le même lot', () => {
		const units = Array.from({ length: 50 }, (_, i) => unit(`r-${i}`, `loc-${i % 4}`, 50 - (i % 7)));
		const shuffled = [...units].reverse();
		expect(keys(selectByLocation(units, 12).units)).toEqual(keys(selectByLocation(shuffled, 12).units));
	});

	it('sous le plafond, rien n’est tronqué', () => {
		const units = Array.from({ length: 5 }, (_, i) => unit(`r-${i}`, 'loc-a', 50 - i));
		const sel = selectByLocation(units, 30);
		expect(sel.truncated).toBe(false);
		expect(sel.units).toHaveLength(5);
	});
});

// ── Confiance, score, sévérité ──────────────────────────────────────

describe('computeReviewConfidence — la synchro qui vieillit est le SEUL doute', () => {
	it('une synchro fraîche donne une pleine confiance, sans caveat', () => {
		const c = computeReviewConfidence({ hoursSinceSync: 0, freshnessHours: 48 });
		expect(c.score).toBe(100);
		expect(c.caveats).toHaveLength(0);
	});

	it('au bord de la fenêtre de fraîcheur, la confiance passe sous 50', () => {
		const c = computeReviewConfidence({ hoursSinceSync: 46, freshnessHours: 48 });
		expect(c.score).toBeLessThan(50);
		expect(c.caveats.length).toBeGreaterThan(0);
	});
});

describe('score et sévérité', () => {
	const base = { rating: 2, overdueBy: 2, locationShare: 0.35, confidenceScore: 90, thresholds: T };

	it('la somme des composantes reste dans [0, 100]', () => {
		const s = scoreReviewUnit({ type: NEGATIVE_REVIEW_TYPE, ...base });
		const total = computePriorityScore(s);
		expect(total).toBeGreaterThanOrEqual(0);
		expect(total).toBeLessThanOrEqual(100);
	});

	it('à note égale, la fiche qui porte l’arriéré remonte', () => {
		// Le fait mesuré : Eaux Vives 190/541 contre Lausanne 1/302.
		const heavy = scoreReviewUnit({ type: REVIEW_PENDING_SLA_TYPE, ...base, locationShare: 0.35 });
		const light = scoreReviewUnit({ type: REVIEW_PENDING_SLA_TYPE, ...base, locationShare: 0.003 });
		expect(computePriorityScore(heavy)).toBeGreaterThan(computePriorityScore(light));
	});

	it('un 1★ est critical, un 3★ est high', () => {
		const sev = (rating: number) =>
			deriveReviewSeverity({ type: NEGATIVE_REVIEW_TYPE, rating, overdueBy: 0, confidenceScore: 90, thresholds: T });
		expect(sev(1)).toBe('critical');
		expect(sev(2)).toBe('critical');
		expect(sev(3)).toBe('high');
	});

	it('le SLA n’atteint JAMAIS critical — il est réservé à ce que §14.3 notifie', () => {
		const sev = deriveReviewSeverity({
			type: REVIEW_PENDING_SLA_TYPE,
			rating: 1,
			overdueBy: 300,
			confidenceScore: 100,
			thresholds: T
		});
		expect(sev).toBe('high');
	});

	it('un 5★ à 15 jours de retard est high, à 5 jours medium, à 1 jour low', () => {
		const sev = (overdueBy: number) =>
			deriveReviewSeverity({ type: REVIEW_PENDING_SLA_TYPE, rating: 5, overdueBy, confidenceScore: 100, thresholds: T });
		expect(sev(15)).toBe('high');
		expect(sev(5)).toBe('medium');
		expect(sev(1)).toBe('low');
	});

	it('une confiance dégradée plafonne la sévérité à medium', () => {
		const sev = deriveReviewSeverity({
			type: NEGATIVE_REVIEW_TYPE,
			rating: 1,
			overdueBy: 0,
			confidenceScore: 40,
			thresholds: T
		});
		expect(sev).toBe('medium');
	});

	it('shouldNotifyImmediately ne vaut que pour un NÉGATIF 1–2★', () => {
		const notify = (type: typeof NEGATIVE_REVIEW_TYPE | typeof REVIEW_PENDING_SLA_TYPE, rating: number) =>
			shouldNotifyImmediately({ type, rating, notifyRatingMax: T.notifyRatingMax });
		expect(notify(NEGATIVE_REVIEW_TYPE, 1)).toBe(true);
		expect(notify(NEGATIVE_REVIEW_TYPE, 2)).toBe(true);
		expect(notify(NEGATIVE_REVIEW_TYPE, 3)).toBe(false);
		expect(notify(REVIEW_PENDING_SLA_TYPE, 1)).toBe(false);
	});
});

// ── Libellés et preuves ─────────────────────────────────────────────

describe('titre — stable, et il NOMME l’établissement', () => {
	it('l’établissement figure dans le titre des deux types', () => {
		const r = pass({ reviews: [review({ rating: 2, createTime: isoDaysAgo(20) })] });
		expect(buildReviewTitle(r.negative.matched[0])).toContain('Barber Concept Eaux Vives');
		expect(buildReviewTitle(r.sla.matched[0])).toContain('Barber Concept Eaux Vives');
	});

	it('le titre ne bouge pas d’un jour à l’autre', () => {
		// `upsertFinding` réécrit `title` à chaque run : y glisser l'âge ferait clignoter l'inbox.
		const created = '2026-07-08T10:00:00Z';
		const today = pass({ reviews: [review({ rating: 2, createTime: created })] });
		const tomorrow = runReviewPendingPass({
			reviews: [review({ rating: 2, createTime: created, lastSeenAt: toDbTimestamp(new Date(NOW.getTime() + DAY - 3_600_000)) })],
			locations: [{ ...FRESH_LOCATION, lastSyncAt: toDbTimestamp(new Date(NOW.getTime() + DAY - 7_200_000)) }],
			backlog: [{ locationId: 'loc-a', total: 100, pending: 10 }],
			thresholds: T,
			now: new Date(NOW.getTime() + DAY)
		});
		expect(buildReviewTitle(tomorrow.negative.matched[0])).toBe(buildReviewTitle(today.negative.matched[0]));
	});
});

describe('preuves — des pointeurs et des mesures, jamais de texte', () => {
	const r = pass({
		reviews: [review({ rating: 2, createTime: isoDaysAgo(20), hasDraft: true })],
		backlog: [{ locationId: 'loc-a', total: 541, pending: 190 }]
	});
	const evidence = buildReviewEvidence({ unit: r.negative.matched[0], thresholds: T });
	const serialized = JSON.stringify(evidence);

	it('aucune donnée personnelle n’entre dans un journal append-only', () => {
		expect(serialized).not.toContain('authorName');
		expect(serialized).not.toContain('author_name');
		expect(serialized).not.toContain('comment');
		expect(serialized).not.toContain('draftReply');
		expect(serialized).not.toContain('draft_reply');
	});

	it('l’arriéré PAR FICHE est dans les preuves — le fait le plus actionnable du lot', () => {
		expect(evidence.locationBacklog).toEqual({ pending: 190, total: 541, share: 0.351 });
	});

	it('le prédicat « en attente » est prouvé par ses DEUX sources', () => {
		expect(evidence.pending).toEqual({ repliedAt: null, remoteReplyAt: null });
	});

	it('le signal de notification voyage dans les preuves, avec sa cause figée', () => {
		expect(evidence.notifyImmediately).toBe(true);
		expect(evidence.notifyReason).toBe(NOTIFY_IMMEDIATELY_REASON);
		expect(evidence.detector).toBe(DETECTOR_REVIEW_PENDING);
	});

	it('les preuves restent petites (elles passent assertBoundedPayload)', () => {
		expect(serialized.length).toBeLessThan(4000);
	});

	it('un brouillon jamais envoyé est un FAIT, son texte n’en est pas un', () => {
		expect(evidence.draft).toEqual({ present: true });
	});
});
