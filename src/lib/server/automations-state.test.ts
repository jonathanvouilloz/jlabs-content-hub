import { describe, it, expect } from 'vitest';
import {
	CADENCE_PERIOD_MS,
	classifyCadence,
	isFailing,
	lastDueOccurrence,
	normalizeAutomationFilters,
	runsHref,
	summarizeAutomations,
	type CadenceRow
} from './automations-state.js';
import {
	BUSINESS_TIMEZONE,
	DEFAULT_LOOKBACK_MS,
	SCHEDULE_DEFAULTS,
	type CadenceSpec
} from './schedule-state.js';

const TZ = BUSINESS_TIMEZONE;
const at = (s: string) => Date.parse(s);
const HOUR = 60 * 60 * 1000;

function spec(over: Partial<CadenceSpec> = {}): CadenceSpec {
	return { ...SCHEDULE_DEFAULTS.weekly, ...over };
}

// ── Dernier créneau dû ──────────────────────────────────────────────

describe('lastDueOccurrence', () => {
	it('rend le dernier lundi 09:00 précédant l’instant donné', () => {
		// Mercredi 22 juillet 2026, 14:00 UTC → le dernier créneau hebdo est le
		// lundi 20 juillet 09:00 heure de Zurich.
		const last = lastDueOccurrence({
			cadence: 'weekly',
			spec: spec(),
			now: at('2026-07-22T14:00:00Z'),
			timeZone: TZ
		});
		expect(last?.localSlot).toBe('2026-07-20T09:00');
	});

	it('rend le créneau du jour même dès qu’il est passé, pas celui d’avant', () => {
		const last = lastDueOccurrence({
			cadence: 'weekly',
			spec: spec(),
			// Lundi 20 juillet, 09:30 locale (07:30 UTC en été) : le créneau vient de passer.
			now: at('2026-07-20T07:30:00Z'),
			timeZone: TZ
		});
		expect(last?.localSlot).toBe('2026-07-20T09:00');
	});

	it('ne rend PAS un créneau encore à venir', () => {
		const last = lastDueOccurrence({
			cadence: 'weekly',
			spec: spec(),
			// Lundi 20 juillet, 06:00 UTC = 08:00 locale : le créneau de 09:00 n'a pas eu lieu.
			now: at('2026-07-20T06:00:00Z'),
			timeZone: TZ
		});
		expect(last?.localSlot).toBe('2026-07-13T09:00');
	});

	it('rend null sur une cadence désactivée (aucun créneau n’est dû)', () => {
		expect(
			lastDueOccurrence({
				cadence: 'weekly',
				spec: spec({ enabled: false }),
				now: at('2026-07-22T14:00:00Z'),
				timeZone: TZ
			})
		).toBeNull();
	});

	it('traverse le passage à l’heure d’hiver sans décaler le créneau métier', () => {
		// Le dimanche 25 octobre 2026, Zurich repasse en CET. Le lundi 26 à 09:00
		// locale vaut 08:00 UTC (contre 07:00 la semaine d'avant).
		const last = lastDueOccurrence({
			cadence: 'weekly',
			spec: spec(),
			now: at('2026-10-27T12:00:00Z'),
			timeZone: TZ
		});
		expect(last?.localSlot).toBe('2026-10-26T09:00');
		expect(new Date(last!.instantMs).toISOString()).toBe('2026-10-26T08:00:00.000Z');
	});

	it('couvre chaque cadence avec un horizon d’au moins deux périodes', () => {
		expect(CADENCE_PERIOD_MS.weekly).toBe(7 * 24 * HOUR);
		const daily = lastDueOccurrence({
			cadence: 'daily',
			spec: SCHEDULE_DEFAULTS.daily,
			now: at('2026-07-22T14:00:00Z'),
			timeZone: TZ
		});
		expect(daily?.localSlot).toBe('2026-07-22T07:00');
	});
});

// ── Verdict de planification ────────────────────────────────────────

const BASE = {
	spec: spec(),
	wired: true,
	nowMs: at('2026-07-22T14:00:00Z'),
	projectCreatedAtMs: at('2026-01-01T00:00:00Z')
};

function due(localSlot: string, iso: string) {
	return { cadence: 'weekly' as const, localSlot, instantMs: at(iso), adjusted: false, ambiguous: false };
}

describe('classifyCadence', () => {
	it('un créneau tiré vaut ok', () => {
		const v = classifyCadence({
			...BASE,
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: 'success'
		});
		expect(v.health).toBe('ok');
	});

	it('un RUN ÉCHOUÉ reste ok sur l’axe planification — les deux axes ne fusionnent pas', () => {
		// C'est le point du lot : le créneau a bien été tiré. Que le run ait échoué
		// est une panne d'EXÉCUTION, qui a ses propres écrans (`/jobs`). Fusionner
		// les deux ferait diagnostiquer un cron mort là où il n'y a qu'un quota
		// provider — et masquerait l'inverse, autrement plus grave.
		for (const status of ['failed', 'partial', 'cancelled', 'running', 'queued']) {
			const v = classifyCadence({
				...BASE,
				lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
				runStatus: status
			});
			expect(v.health, status).toBe('ok');
		}
	});

	it('un créneau manqué DANS la fenêtre est late et annoncé rattrapable', () => {
		const v = classifyCadence({
			...BASE,
			// 4 h après le créneau, fenêtre de rattrapage = 6 h.
			nowMs: at('2026-07-20T11:00:00Z'),
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(v.health).toBe('late');
		expect(v.recoverable).toBe(true);
	});

	it('un créneau manqué HORS fenêtre est missed et jamais annoncé rattrapable', () => {
		const v = classifyCadence({
			...BASE,
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(v.health).toBe('missed');
		expect(v.recoverable).toBe(false);
	});

	it('la bascule late → missed tombe EXACTEMENT sur la fenêtre du scheduler', () => {
		const slotMs = at('2026-07-20T07:00:00Z');
		const justInside = classifyCadence({
			...BASE,
			nowMs: slotMs + DEFAULT_LOOKBACK_MS - 1000,
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		// Pile sur la borne : `dueOccurrences` retient `instantMs > since`, donc le
		// tick ne le tirerait PAS. Le dire rattrapable serait une promesse fausse.
		const onBoundary = classifyCadence({
			...BASE,
			nowMs: slotMs + DEFAULT_LOOKBACK_MS,
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(justInside.health).toBe('late');
		expect(onBoundary.health).toBe('missed');
	});

	it('une cadence non câblée l’emporte sur « désactivée » — l’ordre est celui de planDueJobs', () => {
		// `planDueJobs` écarte les cadences sans handler AVANT de lire `enabled`.
		// Inverser donnerait deux raisons au même silence, dont une fausse.
		const v = classifyCadence({
			...BASE,
			wired: false,
			spec: spec({ enabled: false }),
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(v.health).toBe('unwired');
	});

	it('une cadence désactivée n’est jamais une panne, même sans run', () => {
		const v = classifyCadence({
			...BASE,
			spec: spec({ enabled: false }),
			lastDue: null,
			runStatus: null
		});
		expect(v.health).toBe('disabled');
		expect(isFailing(v.health)).toBe(false);
	});

	it('un créneau antérieur à la création du projet ne lui est pas reproché', () => {
		const v = classifyCadence({
			...BASE,
			projectCreatedAtMs: at('2026-07-21T00:00:00Z'),
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(v.health).toBe('never_due');
		expect(isFailing(v.health)).toBe(false);
	});

	it('sans date de création connue, le créneau manquant reste imputé', () => {
		// Faute de savoir, on ne blanchit pas : un projet dont la date se perd ne
		// doit pas devenir muet — c'est ce silence-là qu'on vient supprimer.
		const v = classifyCadence({
			...BASE,
			projectCreatedAtMs: null,
			lastDue: due('2026-07-20T09:00', '2026-07-20T07:00:00Z'),
			runStatus: null
		});
		expect(v.health).toBe('missed');
	});

	it('seuls late et missed appellent une intervention', () => {
		expect(isFailing('missed')).toBe(true);
		expect(isFailing('late')).toBe(true);
		expect(isFailing('ok')).toBe(false);
		expect(isFailing('unwired')).toBe(false);
		expect(isFailing('never_due')).toBe(false);
	});
});

// ── Résumé ──────────────────────────────────────────────────────────

function row(over: Partial<CadenceRow> & { health: CadenceRow['verdict']['health'] }): CadenceRow {
	const { health, ...rest } = over;
	return {
		projectId: 'p1',
		projectSlug: 'alpha',
		projectName: 'Alpha',
		cadence: 'weekly',
		spec: spec(),
		wired: true,
		lastDueSlot: '2026-07-20T09:00',
		lastDueDb: '2026-07-20 07:00:00',
		nextSlot: '2026-07-27T09:00',
		nextDb: '2026-07-27 07:00:00',
		verdict: { health, reason: '', recoverable: health === 'late' },
		lastRun: null,
		lastSuccess: null,
		pauseScope: health === 'paused' ? 'project_cadence' : null,
		...rest
	};
}

describe('summarizeAutomations', () => {
	it('ne compte comme ATTENDUE qu’une cadence câblée et activée', () => {
		const s = summarizeAutomations([
			row({ health: 'ok' }),
			row({ health: 'unwired', wired: false }),
			row({ health: 'disabled', spec: spec({ enabled: false }) })
		]);
		expect(s.expected).toBe(1);
		expect(s.unwired).toBe(1);
		expect(s.disabled).toBe(1);
	});

	it('nomme les projets qui ont manqué un créneau, dédupliqués et triés', () => {
		const s = summarizeAutomations([
			row({ health: 'missed', projectSlug: 'zeta' }),
			row({ health: 'missed', projectSlug: 'alpha', cadence: 'daily' }),
			row({ health: 'missed', projectSlug: 'alpha' }),
			row({ health: 'late', projectSlug: 'beta' })
		]);
		expect(s.missed).toBe(3);
		expect(s.late).toBe(1);
		expect(s.projectsMissing).toEqual(['alpha', 'zeta']);
	});
});

// ── Filtres & liens ─────────────────────────────────────────────────

describe('normalizeAutomationFilters', () => {
	it('écarte un statut hors vocabulaire sans refuser la page', () => {
		const f = normalizeAutomationFilters({ status: 'success,drop table,failed' });
		expect(f.statuses).toEqual(['success', 'failed']);
	});

	it('déduplique les statuts', () => {
		expect(normalizeAutomationFilters({ status: 'success,success' }).statuses).toEqual(['success']);
	});

	it('n’accepte une borne `since` qu’au format DB', () => {
		expect(normalizeAutomationFilters({ since: '2026-07-20 07:00:00' }).sinceDb).toBe(
			'2026-07-20 07:00:00'
		);
		// Un `T` ISO est ramené au format de la colonne : sans ça, la comparaison
		// lexicographique sur un `text` écarterait des lignes au hasard.
		expect(normalizeAutomationFilters({ since: '2026-07-20T07:00:00' }).sinceDb).toBe(
			'2026-07-20 07:00:00'
		);
		expect(normalizeAutomationFilters({ since: 'hier' }).sinceDb).toBeNull();
		expect(normalizeAutomationFilters({ since: '2026-07-20' }).sinceDb).toBeNull();
	});

	it('n’accepte qu’une cadence connue', () => {
		expect(normalizeAutomationFilters({ cadence: 'weekly' }).cadence).toBe('weekly');
		expect(normalizeAutomationFilters({ cadence: 'yearly' }).cadence).toBeNull();
	});

	it('borne la pagination', () => {
		expect(normalizeAutomationFilters({ limit: '9999' }).limit).toBe(200);
		expect(normalizeAutomationFilters({ limit: '-3' }).limit).toBe(50);
		expect(normalizeAutomationFilters({ offset: '-3' }).offset).toBe(0);
	});
});

describe('runsHref', () => {
	it('reproduit exactement ce qu’un compteur a compté', () => {
		const href = runsHref({
			status: 'failed',
			sinceDb: '2026-07-01 00:00:00',
			projectSlug: 'alpha'
		});
		const url = new URL(href, 'https://x');
		expect(url.pathname).toBe('/automations');
		expect(url.searchParams.get('status')).toBe('failed');
		expect(url.searchParams.get('since')).toBe('2026-07-01 00:00:00');
		expect(url.searchParams.get('project')).toBe('alpha');
		// Le lien produit doit se relire dans le normaliseur sans rien perdre.
		const back = normalizeAutomationFilters({
			status: url.searchParams.get('status'),
			since: url.searchParams.get('since'),
			project: url.searchParams.get('project')
		});
		expect(back.statuses).toEqual(['failed']);
		expect(back.sinceDb).toBe('2026-07-01 00:00:00');
		expect(back.projectSlug).toBe('alpha');
	});

	it('sans filtre, pointe la page nue', () => {
		expect(runsHref({})).toBe('/automations');
	});
});

// ── Pauses (DASH-006 lot 2) ─────────────────────────────────────────

/** Verdict de pause tel que `resolveCadencePause` le rend. */
function pauseVerdict(over: { scope?: string; reason?: string } = {}) {
	return {
		paused: true,
		by: {
			key: 'k',
			target: {
				scope: (over.scope ?? 'project_cadence') as 'project_cadence' | 'project' | 'provider',
				projectId: 'p1',
				cadence: 'weekly' as const,
				provider: null
			},
			reason: over.reason ?? 'jamais diagnostiqué',
			actor: 'user:contact@jonlabs.ch',
			since: '2026-07-25 09:00:00',
			until: null,
			eventId: 'e1'
		}
	};
}

describe('classifyCadence — pauses', () => {
	it('une cadence suspendue se lit `paused`, avec sa cause et son auteur', () => {
		const verdict = classifyCadence({
			spec: spec(),
			wired: true,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: at('2026-01-01T00:00:00Z'),
			pause: pauseVerdict()
		});
		expect(verdict.health).toBe('paused');
		expect(verdict.reason).toMatch(/jamais diagnostiqué/);
		expect(verdict.pause?.actor).toBe('user:contact@jonlabs.ch');
	});

	it('une pause n’est JAMAIS rattrapable : reprendre ne rejoue aucun créneau', () => {
		const verdict = classifyCadence({
			spec: spec(),
			wired: true,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: null,
			pause: pauseVerdict()
		});
		expect(verdict.recoverable).toBe(false);
	});

	it('une pause de PROJET le dit, plutôt que d’accuser la cadence', () => {
		const verdict = classifyCadence({
			spec: spec(),
			wired: true,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: null,
			pause: pauseVerdict({ scope: 'project', reason: 'client gelé' })
		});
		expect(verdict.reason).toMatch(/^Projet suspendu/);
	});

	it('`unwired` passe AVANT la pause : rien n’est câblé, il n’y a rien à suspendre', () => {
		const verdict = classifyCadence({
			spec: spec(),
			wired: false,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: null,
			pause: pauseVerdict()
		});
		expect(verdict.health).toBe('unwired');
	});

	it('`disabled` passe AVANT la pause : reprendre ne rallumerait rien', () => {
		// L'ordre est celui du scheduler (`applyPauseToSpec` ne s'applique qu'à un
		// `enabled` déjà vrai). Inversé, l'écran offrirait un bouton qui marche et
		// après lequel rien ne repart.
		const verdict = classifyCadence({
			spec: spec({ enabled: false }),
			wired: true,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: null,
			pause: pauseVerdict()
		});
		expect(verdict.health).toBe('disabled');
	});

	it('sans pause, le verdict est strictement celui d’avant', () => {
		const base = {
			spec: spec(),
			wired: true,
			lastDue: null,
			runStatus: null,
			nowMs: at('2026-07-26T12:00:00Z'),
			projectCreatedAtMs: null
		};
		expect(classifyCadence(base)).toEqual(
			classifyCadence({ ...base, pause: { paused: false, by: null } })
		);
	});
});

describe('summarizeAutomations — pauses', () => {
	it('une pause n’est NI un échec NI une attente : compteur à part', () => {
		const s = summarizeAutomations([row({ health: 'ok' }), row({ health: 'paused' })]);
		expect(s.paused).toBe(1);
		expect(s.missed).toBe(0);
		expect(s.late).toBe(0);
		// Le point du lot : une décision ne peut pas peindre le cockpit en rouge.
		expect(isFailing('paused')).toBe(false);
	});

	it('une cadence suspendue sort du dénominateur des ATTENDUES', () => {
		// Sinon « 2 attendues, 1 ok » se lirait comme un manque, alors que l'autre est
		// éteinte exprès.
		const s = summarizeAutomations([row({ health: 'ok' }), row({ health: 'paused' })]);
		expect(s.expected).toBe(1);
	});

	it('nomme les projets suspendus, dédupliqués et triés', () => {
		const s = summarizeAutomations([
			row({ health: 'paused', projectSlug: 'zeta', cadence: 'weekly' }),
			row({ health: 'paused', projectSlug: 'alpha', cadence: 'daily' }),
			row({ health: 'paused', projectSlug: 'zeta', cadence: 'monthly' })
		]);
		expect(s.projectsPaused).toEqual(['alpha', 'zeta']);
	});
});
