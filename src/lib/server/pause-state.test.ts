import { describe, it, expect } from 'vitest';
import {
	PAUSE_KEY_SEP,
	PAUSE_SCOPES,
	applyPauseToSpec,
	derivePauseStates,
	describePauseTarget,
	normalizePauseReason,
	normalizePauseTarget,
	pauseKey,
	pausedProviders,
	resolveCadencePause,
	resolveJobPause,
	resolveProviderPause,
	type PauseEventRow
} from './pause-state.js';
import { SCHEDULE_DEFAULTS } from './schedule-state.js';

const NOW = '2026-07-26 12:00:00';

/** Fabrique un événement de journal — seules les colonnes utiles à la dérivation. */
function event(over: Partial<PauseEventRow> = {}): PauseEventRow {
	return {
		id: 'evt-1',
		scope: 'project_cadence',
		projectId: 'p-barber',
		cadence: 'weekly',
		provider: null,
		eventType: 'paused',
		reason: 'jamais diagnostiqué : 50 findings d’un coup',
		until: null,
		actor: 'user:contact@jonlabs.ch',
		createdAt: '2026-07-25 09:00:00',
		...over
	};
}

// ── Normalisation de la cible ───────────────────────────────────────

describe('normalizePauseTarget', () => {
	it('force à null les champs étrangers au scope', () => {
		// Une ligne `project` qui traînerait une cadence produirait DEUX clés pour une
		// seule décision : une pause qu'on croit levée et qui ne l'est pas.
		const target = normalizePauseTarget({
			scope: 'project',
			projectId: 'p-1',
			cadence: 'weekly',
			provider: 'gsc'
		});
		expect(target).toEqual({
			scope: 'project',
			projectId: 'p-1',
			cadence: null,
			provider: null
		});
	});

	it('refuse un scope inconnu', () => {
		expect(() => normalizePauseTarget({ scope: 'everything' })).toThrow(/scope inconnu/);
	});

	it('refuse une pause project_cadence sans cadence valide', () => {
		expect(() => normalizePauseTarget({ scope: 'project_cadence', projectId: 'p-1' })).toThrow(
			/cadence inconnue/
		);
	});

	it('refuse une pause de projet sans projectId', () => {
		expect(() => normalizePauseTarget({ scope: 'project', projectId: '  ' })).toThrow(
			/projectId manquant/
		);
	});

	it('refuse « none » comme provider : c’est l’absence de provider, pas un provider', () => {
		// Le suspendre couperait détecteurs, veilles et producteur — tout ce qui ne sort
		// pas du réseau — sous un libellé qui promet le contraire.
		expect(() => normalizePauseTarget({ scope: 'provider', provider: 'none' })).toThrow(
			/n’est pas un provider/
		);
	});

	it('n’exige aucun projectId pour une pause provider (elle est transverse)', () => {
		const target = normalizePauseTarget({ scope: 'provider', provider: 'gsc' });
		expect(target.projectId).toBeNull();
		expect(target.provider).toBe('gsc');
	});
});

describe('pauseKey', () => {
	it('donne des clés distinctes aux trois scopes d’un même projet', () => {
		const keys = new Set([
			pauseKey({ scope: 'project', projectId: 'p-1', cadence: null, provider: null }),
			pauseKey({ scope: 'project_cadence', projectId: 'p-1', cadence: 'weekly', provider: null }),
			pauseKey({ scope: 'provider', projectId: null, cadence: null, provider: 'gsc' })
		]);
		expect(keys.size).toBe(3);
	});

	it('refuse une partie contenant le séparateur réservé', () => {
		// Sans cette garde la collision serait SILENCIEUSE : une reprise lèverait une
		// pause qui n'est pas la sienne.
		expect(() =>
			pauseKey({
				scope: 'project',
				projectId: `p-1${PAUSE_KEY_SEP}truqué`,
				cadence: null,
				provider: null
			})
		).toThrow(/séparateur réservé/);
	});
});

// ── Dérivation de l'état effectif ───────────────────────────────────

describe('derivePauseStates', () => {
	it('rend active une pause sans échéance', () => {
		const states = derivePauseStates([event()], NOW);
		expect(states.size).toBe(1);
		expect([...states.values()][0].reason).toMatch(/50 findings/);
	});

	it('le dernier événement gagne : une reprise lève la pause', () => {
		const states = derivePauseStates(
			[
				event({ id: 'e1', createdAt: '2026-07-20 09:00:00', eventType: 'paused' }),
				event({ id: 'e2', createdAt: '2026-07-24 09:00:00', eventType: 'resumed' })
			],
			NOW
		);
		expect(states.size).toBe(0);
	});

	it('une re-pause après reprise redevient active', () => {
		const states = derivePauseStates(
			[
				event({ id: 'e1', createdAt: '2026-07-20 09:00:00', eventType: 'paused' }),
				event({ id: 'e2', createdAt: '2026-07-24 09:00:00', eventType: 'resumed' }),
				event({ id: 'e3', createdAt: '2026-07-25 09:00:00', eventType: 'paused' })
			],
			NOW
		);
		expect(states.size).toBe(1);
		expect([...states.values()][0].eventId).toBe('e3');
	});

	it('une échéance ÉCHUE désactive la pause, sans qu’aucune ligne ne bouge', () => {
		const rows = [event({ until: '2026-07-26 08:00:00' })];
		const states = derivePauseStates(rows, NOW);
		expect(states.size).toBe(0);
		// La preuve que rien n'est réécrit : l'entrée du journal est intacte.
		expect(rows[0].eventType).toBe('paused');
		expect(rows[0].until).toBe('2026-07-26 08:00:00');
	});

	it('une échéance FUTURE laisse la pause active', () => {
		const states = derivePauseStates([event({ until: '2026-08-15 09:00:00' })], NOW);
		expect(states.size).toBe(1);
		expect([...states.values()][0].until).toBe('2026-08-15 09:00:00');
	});

	it('PILE sur la borne, l’échéance est atteinte donc la pause est levée', () => {
		// Borne `<=`, comme isSnoozeExpired : une échéance atteinte est atteinte.
		expect(derivePauseStates([event({ until: NOW })], NOW).size).toBe(0);
		expect(derivePauseStates([event({ until: '2026-07-26 12:00:01' })], NOW).size).toBe(1);
	});

	it('un Date et la même chaîne au format DB rendent le MÊME verdict', () => {
		// `new Date('2026-07-26 12:00:00')` est parsé en heure LOCALE : repasser une
		// chaîne déjà canonique par toDbTimestamp la décalerait d'une à deux heures à
		// Zurich, et une pause échéant à 12:00 se lirait active jusqu'à 14:00.
		const untilPasse = event({ until: '2026-07-26 11:59:59' });
		const untilFutur = event({ until: '2026-07-26 12:00:01' });
		const asDate = new Date('2026-07-26T12:00:00Z');
		expect(derivePauseStates([untilPasse], asDate).size).toBe(
			derivePauseStates([untilPasse], NOW).size
		);
		expect(derivePauseStates([untilFutur], asDate).size).toBe(
			derivePauseStates([untilFutur], NOW).size
		);
	});

	it('écarte une ligne illisible sans faire tomber les autres', () => {
		// Défaut sûr : la ligne corrompue se lit « pas en pause ». Une pause fantôme
		// éteindrait un monitoring que personne n'a demandé d'éteindre.
		const states = derivePauseStates(
			[
				event({ id: 'bad', scope: 'galaxie', projectId: 'p-x' }),
				event({ id: 'bad2', scope: 'project_cadence', cadence: 'hebdomadaire' }),
				event({ id: 'ok', projectId: 'p-ok' })
			],
			NOW
		);
		expect(states.size).toBe(1);
		expect([...states.values()][0].eventId).toBe('ok');
	});

	it('ignore un event_type hors vocabulaire', () => {
		expect(derivePauseStates([event({ eventType: 'suspendu' })], NOW).size).toBe(0);
	});
});

// ── Résolution par cadence ──────────────────────────────────────────

describe('resolveCadencePause', () => {
	it('rend « en pause » sur la cadence exactement visée', () => {
		const states = derivePauseStates([event()], NOW);
		const verdict = resolveCadencePause({ states, projectId: 'p-barber', cadence: 'weekly' });
		expect(verdict.paused).toBe(true);
		expect(verdict.by?.target.scope).toBe('project_cadence');
	});

	it('laisse intactes les AUTRES cadences du même projet', () => {
		const states = derivePauseStates([event()], NOW);
		expect(resolveCadencePause({ states, projectId: 'p-barber', cadence: 'daily' }).paused).toBe(
			false
		);
	});

	it('laisse intacts les autres projets', () => {
		const states = derivePauseStates([event()], NOW);
		expect(resolveCadencePause({ states, projectId: 'p-autre', cadence: 'weekly' }).paused).toBe(
			false
		);
	});

	it('une pause PROJET couvre toutes ses cadences', () => {
		const states = derivePauseStates(
			[event({ scope: 'project', cadence: null, reason: 'client gelé' })],
			NOW
		);
		for (const cadence of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
			expect(resolveCadencePause({ states, projectId: 'p-barber', cadence }).paused).toBe(true);
		}
	});

	it('quand les deux existent, c’est la pause la plus LARGE qui est nommée', () => {
		// C'est elle qu'il faudra lever pour que la cadence reparte. Nommer la plus
		// fine ferait cliquer « Reprendre » dans le vide.
		const states = derivePauseStates(
			[
				event({ id: 'fine', scope: 'project_cadence', reason: 'hebdo suspendu' }),
				event({ id: 'large', scope: 'project', cadence: null, reason: 'client gelé' })
			],
			NOW
		);
		const verdict = resolveCadencePause({ states, projectId: 'p-barber', cadence: 'weekly' });
		expect(verdict.by?.eventId).toBe('large');
	});

	it('reprendre la cadence NE LÈVE PAS le gel du projet', () => {
		const states = derivePauseStates(
			[
				event({ id: 'fine', createdAt: '2026-07-20 09:00:00', eventType: 'paused' }),
				event({
					id: 'large',
					scope: 'project',
					cadence: null,
					createdAt: '2026-07-21 09:00:00',
					eventType: 'paused'
				}),
				event({ id: 'fine-off', createdAt: '2026-07-22 09:00:00', eventType: 'resumed' })
			],
			NOW
		);
		const verdict = resolveCadencePause({ states, projectId: 'p-barber', cadence: 'weekly' });
		expect(verdict.paused).toBe(true);
		expect(verdict.by?.eventId).toBe('large');
	});

	it('une pause PROVIDER ne suspend AUCUNE cadence', () => {
		// L'acceptation BACKLOG : le run s'ouvre, seuls les jobs du provider sautent.
		const states = derivePauseStates(
			[event({ scope: 'provider', projectId: null, cadence: null, provider: 'gsc' })],
			NOW
		);
		expect(resolveCadencePause({ states, projectId: 'p-barber', cadence: 'weekly' }).paused).toBe(
			false
		);
	});
});

// ── Résolution par job ──────────────────────────────────────────────

describe('resolveJobPause', () => {
	const gscPaused = () =>
		derivePauseStates(
			[
				event({
					scope: 'provider',
					projectId: null,
					cadence: null,
					provider: 'gsc',
					reason: 'quota épuisé'
				})
			],
			NOW
		);

	it('saute les trois collecteurs GSC quand le provider est en pause', () => {
		const states = gscPaused();
		for (const jobType of [
			'collect:gsc_query_page',
			'collect:sitemap',
			'collect:url_inspection'
		]) {
			const verdict = resolveJobPause({ states, projectId: 'p-1', jobType, runType: 'weekly' });
			expect(verdict.paused, jobType).toBe(true);
			expect(verdict.reason).toMatch(/quota épuisé/);
		}
	});

	it('LAISSE PARTIR les steps qui ne dépendent pas du provider suspendu', () => {
		// Le cœur de l'acceptation : couper GSC ne prive pas le projet de ce qui ne
		// sort pas de Postgres.
		const states = gscPaused();
		for (const jobType of ['findings:lifecycle', 'propose:actions', 'detect:index_transition']) {
			expect(resolveJobPause({ states, projectId: 'p-1', jobType, runType: 'weekly' }).paused,
				jobType
			).toBe(false);
		}
	});

	it('un gel projet saute tous ses jobs, quel que soit le provider', () => {
		const states = derivePauseStates(
			[event({ scope: 'project', projectId: 'p-1', cadence: null })],
			NOW
		);
		expect(
			resolveJobPause({ states, projectId: 'p-1', jobType: 'findings:lifecycle', runType: 'daily' })
				.paused
		).toBe(true);
		expect(
			resolveJobPause({ states, projectId: 'p-2', jobType: 'findings:lifecycle', runType: 'daily' })
				.paused
		).toBe(false);
	});

	it('une pause de cadence ne saute que les jobs de CETTE cadence', () => {
		const states = derivePauseStates([event({ projectId: 'p-1', cadence: 'weekly' })], NOW);
		expect(
			resolveJobPause({ states, projectId: 'p-1', jobType: 'propose:actions', runType: 'weekly' })
				.paused
		).toBe(true);
		expect(
			resolveJobPause({ states, projectId: 'p-1', jobType: 'findings:lifecycle', runType: 'daily' })
				.paused
		).toBe(false);
	});

	it('un job SANS run échappe à une pause de cadence', () => {
		// post_publish / relance manuelle : il n'appartient à aucun cadran. Suspendre le
		// hebdo ne doit pas annuler une vérification J+3 posée à la publication.
		const states = derivePauseStates([event({ projectId: 'p-1', cadence: 'weekly' })], NOW);
		expect(
			resolveJobPause({
				states,
				projectId: 'p-1',
				jobType: 'post_publish:check',
				runType: null
			}).paused
		).toBe(false);
	});

	it('… mais un job sans run reste soumis à la pause de son PROVIDER', () => {
		const states = gscPaused();
		expect(
			resolveJobPause({ states, projectId: 'p-1', jobType: 'post_publish:check', runType: null })
				.paused
		).toBe(true);
	});

	it('un type de job inconnu vaut « none », donc jamais suspendu par un provider', () => {
		const states = gscPaused();
		expect(
			resolveJobPause({ states, projectId: 'p-1', jobType: 'collect:futur', runType: 'weekly' })
				.paused
		).toBe(false);
	});
});

describe('resolveProviderPause / pausedProviders', () => {
	it('« none » n’est jamais suspendu, même si une ligne le prétendait', () => {
		const states = derivePauseStates(
			[event({ scope: 'provider', projectId: null, cadence: null, provider: 'none' })],
			NOW
		);
		expect(resolveProviderPause({ states, provider: 'none' })).toBeNull();
		expect(pausedProviders(states)).toEqual([]);
	});

	it('liste exactement les providers suspendus', () => {
		const states = derivePauseStates(
			[
				event({ id: 'a', scope: 'provider', projectId: null, cadence: null, provider: 'gsc' }),
				event({ id: 'b', scope: 'provider', projectId: null, cadence: null, provider: 'llm' })
			],
			NOW
		);
		expect(pausedProviders(states).sort()).toEqual(['gsc', 'llm']);
	});
});

// ── Application à la planification ──────────────────────────────────

describe('applyPauseToSpec', () => {
	it('éteint une cadence active', () => {
		expect(applyPauseToSpec(SCHEDULE_DEFAULTS.weekly, true).enabled).toBe(false);
	});

	it('ne rallume JAMAIS une cadence déjà désactivée', () => {
		const off = { ...SCHEDULE_DEFAULTS.weekly, enabled: false };
		expect(applyPauseToSpec(off, false).enabled).toBe(false);
	});

	it('rend le spec inchangé quand il n’y a pas de pause (aucune copie inutile)', () => {
		expect(applyPauseToSpec(SCHEDULE_DEFAULTS.daily, false)).toBe(SCHEDULE_DEFAULTS.daily);
	});
});

// ── Raison & libellés ───────────────────────────────────────────────

describe('normalizePauseReason', () => {
	it('refuse une raison vide ou blanche', () => {
		expect(() => normalizePauseReason('   ')).toThrow(/raison est requise/);
		expect(() => normalizePauseReason(null)).toThrow(/raison est requise/);
	});

	it('borne à 500 caractères', () => {
		expect(normalizePauseReason('x'.repeat(900))).toHaveLength(500);
	});
});

describe('describePauseTarget', () => {
	it('nomme la cible avec le slug quand il est connu', () => {
		expect(
			describePauseTarget(
				{ scope: 'project_cadence', projectId: 'p-1', cadence: 'weekly', provider: null },
				'barberconcept'
			)
		).toBe('barberconcept · weekly');
		expect(
			describePauseTarget({ scope: 'provider', projectId: null, cadence: null, provider: 'gsc' })
		).toBe('provider gsc');
	});

	it('couvre les trois scopes du vocabulaire', () => {
		expect(PAUSE_SCOPES).toHaveLength(3);
	});
});
