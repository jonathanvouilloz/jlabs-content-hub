import { describe, it, expect } from 'vitest';
import {
	GmbApiError,
	parseGmbError,
	starRatingToNumber,
	normalizeReviewKey,
	normalizeReview,
	diffReview,
	invalidatesDraft,
	summarizeSync,
	formatSyncError,
	MAX_SYNC_ERROR_CHARS,
	MAX_REVIEW_PAGES,
	REVIEW_PAGE_SIZE,
	type NormalizedReview,
	type StoredReview,
	type LocationSyncOutcome
} from './gmb-reviews-state.js';
import { classifyJobFailure } from '../job-retry.js';

const CTX = { locationId: 'locations/123', locationLabel: 'Plainpalais' };

/** Enveloppe GBP v4 minimale et valide. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'accounts/111/locations/123/reviews/AbC-xyz',
		reviewer: { displayName: 'Jean D.' },
		starRating: 'FIVE',
		comment: 'Super',
		createTime: '2026-07-18T10:52:48.406099Z',
		updateTime: '2026-07-18T10:52:48.406099Z',
		...over
	};
}

// ── parseGmbError + la classification, sans toucher job-retry.ts ───────────────────────

describe('parseGmbError — le corps porte la vérité, pas le statut', () => {
	it('extrait errors[0].reason en priorité sur error.status', () => {
		const err = parseGmbError({
			status: 403,
			locationId: 'locations/123',
			body: JSON.stringify({
				error: {
					status: 'PERMISSION_DENIED',
					message: 'Quota exceeded',
					errors: [{ reason: 'rateLimitExceeded' }]
				}
			})
		});
		// Si `error.status` gagnait, un dépassement de quota deviendrait `permanent`.
		expect(err.reason).toBe('rateLimitExceeded');
		expect(err.status).toBe(403);
		expect(err.locationId).toBe('locations/123');
	});

	it('retombe sur error.status quand errors[] est absent', () => {
		const err = parseGmbError({
			status: 429,
			body: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'slow down' } })
		});
		expect(err.reason).toBe('RESOURCE_EXHAUSTED');
	});

	it("n'invente aucune raison sur un corps illisible", () => {
		const err = parseGmbError({ status: 502, body: '<html>Bad Gateway</html>' });
		expect(err.reason).toBeNull();
		expect(err.status).toBe(502);
		expect(err.message).toContain('Bad Gateway');
	});

	it('conserve retry-after tel que Google l’envoie', () => {
		const err = parseGmbError({ status: 429, body: '{}', retryAfter: '120' });
		expect(err.retryAfter).toBe('120');
	});
});

describe('classifyJobFailure lit GmbApiError SANS que job-retry.ts soit modifié', () => {
	// C'est LE test qui justifie la forme de la classe : `status` et `reason` sont les noms
	// exacts que `extractStatus` et `collectMarkers` cherchent.
	const cases: Array<{ label: string; status: number; body: string; expect: string }> = [
		{
			label: '403 rateLimitExceeded → quota (et non permanent)',
			status: 403,
			body: JSON.stringify({
				error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }] }
			}),
			expect: 'quota'
		},
		{
			label: '429 RESOURCE_EXHAUSTED → quota',
			status: 429,
			body: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }),
			expect: 'quota'
		},
		{
			label: '401 UNAUTHENTICATED → auth',
			status: 401,
			body: JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'Invalid token' } }),
			expect: 'auth'
		},
		{
			label: '403 PERMISSION_DENIED nu → permanent',
			status: 403,
			body: JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'no access' } }),
			expect: 'permanent'
		},
		{
			label: '404 NOT_FOUND (fiche supprimée) → permanent',
			status: 404,
			body: JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Location not found' } }),
			expect: 'permanent'
		},
		{
			label: '500 sans corps → retryable',
			status: 500,
			body: '',
			expect: 'retryable'
		}
	];

	for (const c of cases) {
		it(c.label, () => {
			const err = parseGmbError({ status: c.status, body: c.body, locationId: 'locations/1' });
			expect(classifyJobFailure(err).errorClass).toBe(c.expect);
		});
	}

	it('honore Retry-After pour le refroidissement JOB-006', () => {
		const err = parseGmbError({ status: 429, body: '{}', retryAfter: '90' });
		expect(classifyJobFailure(err).retryAfterMs).toBe(90_000);
	});

	it('reste une Error : le message survit à la normalisation', () => {
		const err = parseGmbError({ status: 429, body: '{}' });
		expect(err).toBeInstanceOf(Error);
		expect(classifyJobFailure(err).message).toContain('GMB 429');
	});
});

// ── L'identité ─────────────────────────────────────────────────────────────────────────

describe('normalizeReviewKey — l’identité survit à un changement de compte', () => {
	it('rend la même clé pour un path complet, un id nu et un autre compte', () => {
		const nu = 'AbC-xyz';
		expect(normalizeReviewKey('accounts/111/locations/123/reviews/AbC-xyz')).toBe(nu);
		expect(normalizeReviewKey('accounts/999/locations/123/reviews/AbC-xyz')).toBe(nu);
		expect(normalizeReviewKey('AbC-xyz')).toBe(nu);
	});

	it('tolère les slashs de bord et la chaîne vide', () => {
		expect(normalizeReviewKey('/reviews/AbC/')).toBe('AbC');
		expect(normalizeReviewKey('   ')).toBe('');
		expect(normalizeReviewKey('')).toBe('');
	});
});

describe('starRatingToNumber — 0 veut dire ILLISIBLE, jamais zéro étoile', () => {
	it('mappe les cinq valeurs GBP', () => {
		expect(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].map(starRatingToNumber)).toEqual([1, 2, 3, 4, 5]);
	});
	it('rend 0 sur STAR_RATING_UNSPECIFIED, null et undefined', () => {
		expect(starRatingToNumber('STAR_RATING_UNSPECIFIED')).toBe(0);
		expect(starRatingToNumber(null)).toBe(0);
		expect(starRatingToNumber(undefined)).toBe(0);
	});
});

// ── La normalisation ───────────────────────────────────────────────────────────────────

describe('normalizeReview — null est un trou nommé, jamais un objet à champs vides', () => {
	it('normalise une enveloppe complète, horodatages au format DB', () => {
		const n = normalizeReview(
			raw({ reviewReply: { comment: 'Merci !', updateTime: '2026-07-20T08:00:00Z' } }),
			CTX
		);
		expect(n).not.toBeNull();
		expect(n!.reviewKey).toBe('AbC-xyz');
		expect(n!.reviewName).toBe('accounts/111/locations/123/reviews/AbC-xyz');
		expect(n!.rating).toBe(5);
		expect(n!.remoteReplyText).toBe('Merci !');
		// Format DB, PAS l'ISO de Google : sinon la comparaison lexicale est cassée.
		expect(n!.remoteReplyAt).toBe('2026-07-20 08:00:00');
		expect(n!.remoteUpdateAt).toBe('2026-07-18 10:52:48');
		// `createTime` reste tel quel : colonne historique, jamais réécrite.
		expect(n!.createTime).toBe('2026-07-18T10:52:48.406099Z');
	});

	it('rend null sans identité exploitable', () => {
		expect(normalizeReview(raw({ name: undefined, reviewId: undefined }), CTX)).toBeNull();
		expect(normalizeReview(raw({ name: '   ' }), CTX)).toBeNull();
	});

	it('rend null sans date de création — jamais un avis « reçu en l’an 0 »', () => {
		expect(normalizeReview(raw({ createTime: undefined }), CTX)).toBeNull();
		expect(normalizeReview(raw({ createTime: '' }), CTX)).toBeNull();
	});

	it('rend null sur une valeur qui n’est pas un objet', () => {
		expect(normalizeReview(null, CTX)).toBeNull();
		expect(normalizeReview('AbC', CTX)).toBeNull();
	});

	it('accepte une note sans texte et un auteur anonyme (cas GBP légitimes)', () => {
		const n = normalizeReview(raw({ comment: undefined, reviewer: {} }), CTX);
		expect(n!.comment).toBe('');
		expect(n!.authorName).toBe('Anonyme');
	});

	it('rend rating 0 sur une note illisible sans rejeter l’avis', () => {
		const n = normalizeReview(raw({ starRating: 'STAR_RATING_UNSPECIFIED' }), CTX);
		expect(n!.rating).toBe(0);
	});

	it('rend remoteReplyAt null sur un updateTime illisible plutôt qu’une date inventée', () => {
		const n = normalizeReview(raw({ reviewReply: { comment: 'ok', updateTime: 'jamais' } }), CTX);
		expect(n!.remoteReplyText).toBe('ok');
		expect(n!.remoteReplyAt).toBeNull();
	});

	it('reprend reviewId quand name est absent', () => {
		const n = normalizeReview(raw({ name: undefined, reviewId: 'XyZ' }), CTX);
		expect(n!.reviewKey).toBe('XyZ');
	});
});

// ── Le diff ────────────────────────────────────────────────────────────────────────────

function stored(over: Partial<StoredReview> = {}): StoredReview {
	return {
		reviewKey: 'AbC-xyz',
		rating: 5,
		comment: 'Super',
		authorName: 'Jean D.',
		locationLabel: 'Plainpalais',
		remoteReplyText: null,
		remoteReplyAt: null,
		remoteUpdateAt: '2026-07-18 10:52:48',
		...over
	};
}

function incoming(over: Partial<NormalizedReview> = {}): NormalizedReview {
	return {
		reviewKey: 'AbC-xyz',
		reviewName: 'accounts/111/locations/123/reviews/AbC-xyz',
		locationId: 'locations/123',
		locationLabel: 'Plainpalais',
		authorName: 'Jean D.',
		rating: 5,
		comment: 'Super',
		createTime: '2026-07-18T10:52:48.406099Z',
		remoteReplyText: null,
		remoteReplyAt: null,
		remoteUpdateAt: '2026-07-18 10:52:48',
		...over
	};
}

describe('diffReview', () => {
	it('une charge identique ne produit AUCUNE écriture de contenu', () => {
		// L'acceptation GMB-002 « deux syncs ne créent pas deux avis » cesse d'être gratuite
		// dès qu'on passe de onConflictDoNothing à onConflictDoUpdate.
		expect(diffReview(stored(), incoming())).toEqual({ action: 'unchanged', fields: [] });
	});

	it('une ligne absente est un insert', () => {
		expect(diffReview(null, incoming())).toEqual({ action: 'insert', fields: [] });
	});

	it('une réponse ajoutée chez Google est un update sur les seules colonnes distantes', () => {
		const d = diffReview(
			stored(),
			incoming({ remoteReplyText: 'Merci !', remoteReplyAt: '2026-07-20 08:00:00' })
		);
		expect(d.action).toBe('update');
		expect(d.fields.sort()).toEqual(['remoteReplyAt', 'remoteReplyText']);
	});

	it('une note ou un commentaire modifié invalide le brouillon (GMB-002)', () => {
		expect(invalidatesDraft(diffReview(stored(), incoming({ rating: 2 })))).toBe(true);
		expect(invalidatesDraft(diffReview(stored(), incoming({ comment: 'Finalement non' })))).toBe(
			true
		);
	});

	it('une réponse distante seule n’invalide PAS le brouillon', () => {
		const d = diffReview(stored(), incoming({ remoteReplyText: 'Merci !' }));
		expect(invalidatesDraft(d)).toBe(false);
	});

	it('ne compare JAMAIS les colonnes locales', () => {
		// `draft_reply`, `replied_at` et `mentioned_employees` n'existent pas dans les types du
		// diff : Google n'en sait rien, donc n'a rien à en dire. Ce test verrouille la forme.
		const d = diffReview(stored(), incoming());
		expect(Object.keys(stored())).not.toContain('draftReply');
		expect(Object.keys(stored())).not.toContain('repliedAt');
		expect(d.fields).not.toContain('createTime' as never);
	});
});

// ── Le résumé ──────────────────────────────────────────────────────────────────────────

function outcome(over: Partial<LocationSyncOutcome> = {}): LocationSyncOutcome {
	return {
		locationId: 'locations/1',
		locationLabel: 'L1',
		status: 'success',
		seen: 10,
		inserted: 2,
		updated: 1,
		unchanged: 7,
		unreadable: 0,
		truncated: false,
		error: null,
		...over
	};
}

describe('summarizeSync — allFailed porte la règle d’échec du job', () => {
	it('agrège et ne signale pas d’échec quand une seule location réussit', () => {
		const s = summarizeSync([
			outcome(),
			outcome({ locationId: 'locations/2', status: 'error', seen: 0, inserted: 0, updated: 0, unchanged: 0, error: 'HTTP 404' })
		]);
		expect(s).toMatchObject({ locations: 2, succeeded: 1, failed: 1, inserted: 2, allFailed: false });
	});

	it('signale allFailed quand AUCUNE location ne réussit', () => {
		// Une panne totale ne doit pas s'enregistrer comme un succès : le détecteur du lot 2
		// hériterait d'un scope vide qu'il prendrait pour un parc sain.
		const s = summarizeSync([outcome({ status: 'error' }), outcome({ status: 'error' })]);
		expect(s.allFailed).toBe(true);
	});

	it('un projet SANS fiche GMB n’est pas un échec', () => {
		// Cinq des neuf projets sont dans ce cas — leur job doit réussir, pas échouer.
		expect(summarizeSync([]).allFailed).toBe(false);
		expect(summarizeSync([]).locations).toBe(0);
	});

	it('propage la troncature dès qu’une seule location est incomplète', () => {
		expect(summarizeSync([outcome(), outcome({ truncated: true })]).truncated).toBe(true);
	});
});

describe('formatSyncError — borné, et structuré quand l’erreur l’est', () => {
	it('expose statut et raison en tête', () => {
		const err = parseGmbError({
			status: 403,
			body: JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })
		});
		const s = formatSyncError(err);
		expect(s).toContain('HTTP 403');
		expect(s).toContain('rateLimitExceeded');
	});

	it('borne un corps géant — cette colonne est lue par un écran', () => {
		const s = formatSyncError(new Error('x'.repeat(5000)));
		expect(s.length).toBe(MAX_SYNC_ERROR_CHARS);
	});

	it('accepte une valeur qui n’est pas une Error', () => {
		expect(formatSyncError('boom')).toBe('boom');
	});
});

describe('bornes', () => {
	it('la pagination est bornée — la boucle actuelle ne l’est pas', () => {
		expect(MAX_REVIEW_PAGES).toBe(200);
		expect(REVIEW_PAGE_SIZE).toBe(50);
		// Deux ordres de grandeur au-dessus du plus gros parc mesuré (barberconcept, 379).
		expect(MAX_REVIEW_PAGES * REVIEW_PAGE_SIZE).toBeGreaterThan(379 * 10);
	});
});

describe('GmbApiError', () => {
	it('porte les champs sous les noms que job-retry.ts lit', () => {
		const err = new GmbApiError({ status: 429, message: 'm', reason: 'r', locationId: 'l' });
		expect(err.name).toBe('GmbApiError');
		expect({ status: err.status, reason: err.reason, locationId: err.locationId }).toEqual({
			status: 429,
			reason: 'r',
			locationId: 'l'
		});
	});

	it('rend null plutôt qu’undefined sur les champs optionnels', () => {
		const err = new GmbApiError({ status: 500, message: 'm' });
		expect(err.reason).toBeNull();
		expect(err.retryAfter).toBeNull();
		expect(err.locationId).toBeNull();
	});
});
