import { describe, it, expect } from 'vitest';
import {
	DEFAULT_WINDOW_DAYS,
	ACTIVITY_EVENTS,
	normalizeWindowDays,
	deriveFreshness,
	parseDbTimestampMs,
	groupActivity,
	emptyActivity,
	counterHref,
	buildCounter,
	classifyPipeline,
	classifySignal,
	classifyProject,
	deriveDiagnosisCoverage,
	detectorLabel,
	type DetectorCoverage,
	rankProjects,
	projectsNeedingAction,
	summarizePortfolio,
	summarizeCosts,
	stateRank,
	needsAction,
	summarizeProjectPause,
	pauseSuspendsFreshness,
	type ProjectCardInput,
	type IntegrationSummary,
	type ActivityCounts,
	type ProjectPause
} from './home-state.js';
import { derivePauseStates, type PauseEventRow } from './pause-state.js';
import type { ScheduleCadence } from './schedule-state.js';

const NOW = new Date('2026-07-25T12:00:00Z');
const SINCE = '2026-07-18 12:00:00';

/** Un événement du journal de pauses, réduit à ce que la dérivation lit. */
function pauseRow(over: Partial<PauseEventRow> = {}): PauseEventRow {
	return {
		id: over.id ?? 'evt-1',
		scope: over.scope ?? 'project',
		projectId: over.projectId !== undefined ? over.projectId : 'p1',
		cadence: over.cadence ?? null,
		provider: over.provider ?? null,
		eventType: over.eventType ?? 'paused',
		reason: over.reason ?? 'contrat en pause jusqu’à la reprise du client',
		until: over.until ?? null,
		actor: over.actor ?? 'user:contact@jonlabs.ch',
		createdAt: over.createdAt ?? '2026-07-20 08:00:00'
	};
}

const ALL_CADENCES_ENABLED: Record<ScheduleCadence, boolean> = {
	hourly: true,
	daily: true,
	weekly: true,
	monthly: true
};

/** Passe par la VRAIE dérivation : les tests exercent l'union des portées et l'expiration. */
function pauseOf(
	rows: PauseEventRow[],
	over: { projectId?: string; enabled?: Record<ScheduleCadence, boolean>; now?: Date } = {}
): ProjectPause | null {
	return summarizeProjectPause({
		projectId: over.projectId ?? 'p1',
		states: derivePauseStates(rows, over.now ?? NOW),
		enabledByCadence: over.enabled ?? ALL_CADENCES_ENABLED
	});
}

function integration(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
	return {
		provider: over.provider ?? 'gsc',
		healthStatus: over.healthStatus ?? 'healthy',
		status: over.status ?? 'active',
		enabled: over.enabled ?? true,
		lastSuccessAt: over.lastSuccessAt ?? '2026-07-24 09:00:00',
		lastErrorCode: over.lastErrorCode ?? null
	};
}

function activity(over: Partial<ActivityCounts> = {}): ActivityCounts {
	return { ...emptyActivity(), ...over };
}

/** Deux détecteurs attendus, tous deux passés — la couverture COMPLÈTE, cas nominal. */
function detectors(over?: DetectorCoverage[]): DetectorCoverage[] {
	return (
		over ?? [
			{ detector: 'detect:keyword_opportunity', lastSuccessAt: '2026-07-21 09:04:00' },
			{ detector: 'detect:index_transition', lastSuccessAt: '2026-07-21 09:06:00' }
		]
	);
}

/** Couverture complète, pour les tests qui n'interrogent pas cet axe. */
const FULL_DIAGNOSIS = deriveDiagnosisCoverage(detectors());

function card(over: Partial<ProjectCardInput> = {}): ProjectCardInput {
	return {
		projectId: over.projectId ?? 'p1',
		slug: over.slug ?? 'alpha',
		name: over.name ?? 'Alpha',
		color: over.color ?? null,
		integrations: over.integrations ?? [integration()],
		openBySeverity: over.openBySeverity ?? {},
		activity: over.activity ?? activity(),
		proposalsPending: over.proposalsPending ?? 0,
		reviewsUnanswered: over.reviewsUnanswered ?? 0,
		jobsDead: over.jobsDead ?? 0,
		gscLastSuccessAt: over.gscLastSuccessAt ?? '2026-07-24 09:00:00',
		detectors: over.detectors ?? detectors(),
		pause: over.pause ?? null,
		sinceDb: over.sinceDb ?? SINCE,
		now: over.now ?? NOW,
		staleAfterHours: over.staleAfterHours ?? 24 * 10
	};
}

describe('fenêtre de la période', () => {
	it('vaut 7 jours par défaut', () => {
		expect(DEFAULT_WINDOW_DAYS).toBe(7);
		expect(normalizeWindowDays(undefined)).toBe(7);
		expect(normalizeWindowDays('')).toBe(7);
		expect(normalizeWindowDays('bogus')).toBe(7);
	});

	it('borne les valeurs extrêmes sans jamais rendre 0', () => {
		expect(normalizeWindowDays('0')).toBe(1);
		expect(normalizeWindowDays('-30')).toBe(1);
		expect(normalizeWindowDays('9999')).toBe(90);
		expect(normalizeWindowDays('28')).toBe(28);
	});
});

describe('fraîcheur', () => {
	it('« jamais collecté » n’est pas un âge de 0 heure', () => {
		const f = deriveFreshness({ lastSuccessAt: null, now: NOW, staleAfterHours: 48 });
		expect(f.state).toBe('never');
		expect(f.ageHours).toBeNull();
		expect(f.ageHours).not.toBe(0);
	});

	it('distingue fresh et stale sur le seuil', () => {
		const fresh = deriveFreshness({ lastSuccessAt: '2026-07-25 00:00:00', now: NOW, staleAfterHours: 48 });
		expect(fresh.state).toBe('fresh');
		expect(fresh.ageHours).toBeCloseTo(12, 5);

		const stale = deriveFreshness({ lastSuccessAt: '2026-07-20 12:00:00', now: NOW, staleAfterHours: 48 });
		expect(stale.state).toBe('stale');
		expect(stale.ageHours).toBeCloseTo(120, 5);
	});

	it('lit le format DB en UTC (jamais en heure locale)', () => {
		// Sans le suffixe Z ajouté, un serveur à UTC+2 lirait 10:00 et rendrait un âge faux.
		expect(parseDbTimestampMs('2026-07-25 12:00:00')).toBe(Date.parse('2026-07-25T12:00:00Z'));
		expect(parseDbTimestampMs('2026-07-25T12:00:00.000Z')).toBe(Date.parse('2026-07-25T12:00:00Z'));
		expect(parseDbTimestampMs('pas une date')).toBeNull();
	});

	it('un horodatage illisible retombe sur « never », pas sur un âge absurde', () => {
		const f = deriveFreshness({ lastSuccessAt: 'jamais', now: NOW, staleAfterHours: 48 });
		expect(f.state).toBe('never');
		expect(f.ageHours).toBeNull();
	});
});

describe('activité de la période', () => {
	it('regroupe les 4 événements du catalogue', () => {
		expect(ACTIVITY_EVENTS).toEqual(['created', 'aggravated', 'improved', 'resolved']);
		const counts = groupActivity([
			{ eventType: 'created', n: 3 },
			{ eventType: 'aggravated', n: 2 },
			{ eventType: 'resolved', n: 1 }
		]);
		expect(counts).toEqual({ created: 3, aggravated: 2, improved: 0, resolved: 1 });
	});

	it('ignore les événements hors catalogue au lieu de les replier sur « autre »', () => {
		const counts = groupActivity([
			{ eventType: 'agent_comment', n: 12 },
			{ eventType: 'snoozed', n: 4 },
			{ eventType: 'created', n: 1 }
		]);
		// Un commentaire d'agent n'est pas une aggravation : la période ne doit pas gonfler
		// d'un bruit que personne ne peut ouvrir.
		expect(counts.created).toBe(1);
		expect(counts.aggravated).toBe(0);
		expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
	});
});

describe('compteurs : le nombre et son lien viennent du même filtre', () => {
	it('l’activité vise l’inbox avec event + since ET tous les statuts', () => {
		const href = counterHref({
			kind: 'findings_activity',
			event: 'resolved',
			sinceDb: SINCE,
			projectSlug: 'alpha'
		});
		expect(href).not.toBeNull();
		const url = new URL(href!, 'https://x');
		expect(url.pathname).toBe('/inbox');
		expect(url.searchParams.get('tab')).toBe('findings');
		expect(url.searchParams.get('event')).toBe('resolved');
		expect(url.searchParams.get('since')).toBe(SINCE);
		expect(url.searchParams.get('project')).toBe('alpha');
		// Sans ça, le défaut « statuts actifs » de l'inbox écarterait les findings
		// `resolved` que ce compteur vient précisément de compter.
		expect(url.searchParams.get('fstatus')).toContain('resolved');
	});

	it('« ouverts » n’écrit PAS fstatus : le défaut de l’inbox EST cet ensemble', () => {
		const href = counterHref({ kind: 'findings_open', projectSlug: 'alpha' });
		const url = new URL(href!, 'https://x');
		expect(url.searchParams.get('fstatus')).toBeNull();
		expect(url.searchParams.get('tab')).toBe('findings');
	});

	it('les propositions à valider visent le statut proposed', () => {
		const url = new URL(counterHref({ kind: 'proposals_pending', projectSlug: 'alpha' })!, 'https://x');
		expect(url.pathname).toBe('/inbox');
		expect(url.searchParams.get('status')).toBe('proposed');
	});

	it('un compteur sans liste cohérente n’a PAS de lien plutôt qu’un lien qui mentirait', () => {
		// Aucune vue cross-projet des avis n'existe : sans slug, pas de lien.
		expect(counterHref({ kind: 'reviews_unanswered', projectSlug: null })).toBeNull();
		expect(counterHref({ kind: 'reviews_unanswered', projectSlug: 'alpha' })).toBe(
			'/projects/alpha/reviews'
		);
	});

	it('DASH-006 — les runs de la période ouvrent la liste qui applique le MÊME filtre', () => {
		// Ce compteur est resté muet jusqu'à ce qu'une liste de runs existe : `/jobs`
		// liste des jobs, et l'y envoyer aurait ouvert un autre ensemble.
		const url = new URL(
			counterHref({ kind: 'runs_period', status: 'failed', sinceDb: SINCE })!,
			'https://x'
		);
		expect(url.pathname).toBe('/automations');
		expect(url.searchParams.get('status')).toBe('failed');
		expect(url.searchParams.get('since')).toBe(SINCE);
		// Sans projet, aucun paramètre projet : le compteur de l'accueil compte
		// TOUS les projets, et en ajouter un ouvrirait un ensemble plus étroit.
		expect(url.searchParams.get('project')).toBeNull();
	});

	it('buildCounter porte le filtre qui a servi à compter', () => {
		const c = buildCounter('aggravés', 4, {
			kind: 'findings_activity',
			event: 'aggravated',
			sinceDb: SINCE,
			projectSlug: 'alpha'
		});
		expect(c.count).toBe(4);
		expect(c.filter.kind).toBe('findings_activity');
		expect(c.href).toContain('event=aggravated');
	});
});

describe('axe pipeline : est-ce que la donnée arrive ?', () => {
	const freshOk = deriveFreshness({ lastSuccessAt: '2026-07-24 09:00:00', now: NOW, staleAfterHours: 240 });

	it('une intégration en erreur ou révoquée casse le pipeline', () => {
		expect(
			classifyPipeline({
				integrations: [integration({ status: 'error', lastErrorCode: 'invalid_grant' })],
				freshness: freshOk,
				jobsDead: 0
			}).state
		).toBe('broken');
		expect(
			classifyPipeline({
				integrations: [integration({ status: 'revoked' })],
				freshness: freshOk,
				jobsDead: 0
			}).state
		).toBe('broken');
		expect(
			classifyPipeline({
				integrations: [integration({ healthStatus: 'down' })],
				freshness: freshOk,
				jobsDead: 0
			}).state
		).toBe('broken');
	});

	it('nomme le code d’erreur pour que la panne soit actionnable', () => {
		const v = classifyPipeline({
			integrations: [integration({ status: 'error', lastErrorCode: 'invalid_grant' })],
			freshness: freshOk,
			jobsDead: 0
		});
		expect(v.reasons[0]).toContain('invalid_grant');
	});

	it('un retard de collecte DÉGRADE, il ne casse pas', () => {
		const stale = deriveFreshness({ lastSuccessAt: '2026-06-01 09:00:00', now: NOW, staleAfterHours: 240 });
		const v = classifyPipeline({ integrations: [integration()], freshness: stale, jobsDead: 0 });
		expect(v.state).toBe('degraded');
		expect(v.reasons.join(' ')).toContain('retard');
	});

	it('un job en dead-letter dégrade le pipeline', () => {
		expect(classifyPipeline({ integrations: [integration()], freshness: freshOk, jobsDead: 2 }).state).toBe(
			'degraded'
		);
	});

	it('une intégration inactive n’est PAS une panne', () => {
		// Un flux qu'on n'a pas branché ne doit pas faire crier six projets.
		const v = classifyPipeline({
			integrations: [integration({ provider: 'plausible', status: 'inactive', enabled: false, healthStatus: 'unknown' })],
			freshness: freshOk,
			jobsDead: 0
		});
		expect(v.state).toBe('ok');
	});

	it('rien de déclaré et rien de collecté vaut « unknown », jamais « ok »', () => {
		const never = deriveFreshness({ lastSuccessAt: null, now: NOW, staleAfterHours: 240 });
		const v = classifyPipeline({ integrations: [], freshness: never, jobsDead: 0 });
		expect(v.state).toBe('unknown');
	});
});

describe('axe signal : une collecte cassée rend le signal INCONNU, jamais bon', () => {
	it('pipeline cassé → signal unknown même sans aucun finding', () => {
		const v = classifySignal({ openBySeverity: {}, activity: activity(), pipeline: 'broken', diagnosis: FULL_DIAGNOSIS });
		expect(v.state).toBe('unknown');
		expect(v.reasons[0]).toContain('non fiable');
	});

	it('ce qui est déjà connu reste dit sous une collecte cassée', () => {
		const v = classifySignal({
			openBySeverity: { critical: 2 },
			activity: activity(),
			pipeline: 'broken', diagnosis: FULL_DIAGNOSIS });
		expect(v.state).toBe('unknown');
		expect(v.reasons.join(' ')).toContain('2 finding critique');
	});

	it('un critique ou une aggravation met le signal at_risk', () => {
		expect(classifySignal({ openBySeverity: { critical: 1 }, activity: activity(), pipeline: 'ok', diagnosis: FULL_DIAGNOSIS }).state).toBe(
			'at_risk'
		);
		expect(
			classifySignal({ openBySeverity: {}, activity: activity({ aggravated: 1 }), pipeline: 'ok', diagnosis: FULL_DIAGNOSIS }).state
		).toBe('at_risk');
	});

	it('une sévérité haute seule met en surveillance', () => {
		expect(classifySignal({ openBySeverity: { high: 3 }, activity: activity(), pipeline: 'ok', diagnosis: FULL_DIAGNOSIS }).state).toBe(
			'watch'
		);
	});

	it('un signal ok sur données en retard le DIT', () => {
		const v = classifySignal({ openBySeverity: {}, activity: activity(), pipeline: 'degraded', diagnosis: FULL_DIAGNOSIS });
		expect(v.state).toBe('ok');
		expect(v.reasons.join(' ')).toContain('retard');
	});
});

describe('couverture de diagnostic : « jamais regardé » n’est pas « rien à signaler »', () => {
	const NEVER = detectors([
		{ detector: 'detect:keyword_opportunity', lastSuccessAt: null },
		{ detector: 'detect:index_transition', lastSuccessAt: null }
	]);
	const PARTIAL = detectors([
		{ detector: 'detect:keyword_opportunity', lastSuccessAt: '2026-07-21 09:04:00' },
		{ detector: 'detect:index_transition', lastSuccessAt: null }
	]);

	it('dérive les trois états de couverture', () => {
		expect(deriveDiagnosisCoverage(NEVER).state).toBe('none');
		expect(deriveDiagnosisCoverage(PARTIAL).state).toBe('partial');
		expect(deriveDiagnosisCoverage(detectors()).state).toBe('full');
		expect(deriveDiagnosisCoverage(PARTIAL).neverRan).toEqual(['detect:index_transition']);
	});

	it('aucun détecteur attendu vaut « none », jamais « full »', () => {
		// Couper la planification d'un projet ne le rend pas sain : ça arrête de le regarder.
		const c = deriveDiagnosisCoverage([]);
		expect(c.state).toBe('none');
		expect(c.expectedCount).toBe(0);
	});

	it('LE BUG : un projet jamais diagnostiqué ne se lit plus « ok »', () => {
		// barberconcept au 2026-07-26 : collecte GSC fraîche, zéro finding, jamais détecté.
		// Avant ce correctif, l'accueil l'affichait « Sain » — le plus sain du portefeuille.
		const v = classifySignal({
			openBySeverity: {},
			activity: activity(),
			pipeline: 'ok',
			diagnosis: deriveDiagnosisCoverage(NEVER)
		});
		expect(v.state).toBe('unknown');
		expect(v.state).not.toBe('ok');
		expect(v.reasons[0]).toContain('jamais tourné');
	});

	it('la carte entière bascule en « unknown » et le dit dans sa phrase', () => {
		const c = classifyProject(card({ slug: 'barberconcept', detectors: NEVER }));
		// L'axe pipeline reste SAIN : c'est bien le signal qui manque, pas la collecte.
		expect(c.pipeline.state).toBe('ok');
		expect(c.signal.state).toBe('unknown');
		expect(c.state).toBe('unknown');
		expect(c.headline).toContain('État inconnu');
		expect(c.headline).toContain('jamais tourné');
		expect(c.diagnosis.state).toBe('none');
	});

	it('un diagnostic incomplet interdit « ok » mais laisse passer ce qui est su', () => {
		// Rien trouvé côté mots-clés ne vaut rien pour l'indexation, jamais examinée.
		const vide = classifySignal({
			openBySeverity: {},
			activity: activity(),
			pipeline: 'ok',
			diagnosis: deriveDiagnosisCoverage(PARTIAL)
		});
		expect(vide.state).toBe('watch');
		expect(vide.state).not.toBe('ok');
		expect(vide.reasons.join(' ')).toContain('diagnostic incomplet');
		expect(vide.reasons.join(' ')).toContain(detectorLabel('detect:index_transition'));

		// En revanche un critique RÉEL reste un critique : l'angle mort ne l'efface pas.
		const critique = classifySignal({
			openBySeverity: { critical: 1 },
			activity: activity(),
			pipeline: 'ok',
			diagnosis: deriveDiagnosisCoverage(PARTIAL)
		});
		expect(critique.state).toBe('at_risk');
		expect(critique.reasons.join(' ')).toContain('diagnostic incomplet');
	});

	it('une couverture complète et rien à signaler rend bien « ok »', () => {
		// Le correctif ne doit pas rendre tout le portefeuille gris : sur un diagnostic
		// réellement complet, le vert reste atteignable.
		const c = classifyProject(card({ detectors: detectors() }));
		expect(c.signal.state).toBe('ok');
		expect(c.state).toBe('ok');
		expect(c.headline).toBe('Collecte et performance au vert');
	});

	it('un projet jamais diagnostiqué passe AVANT un projet en surveillance', () => {
		// `unknown` devance `watch` (STATE_RANK) : un projet muet peut cacher n'importe quoi.
		const muet = classifyProject(card({ slug: 'muet', detectors: NEVER }));
		const surveille = classifyProject(card({ slug: 'surveille', openBySeverity: { high: 2 } }));
		expect(rankProjects([surveille, muet]).map((c) => c.slug)).toEqual(['muet', 'surveille']);
	});

	it('« jamais examiné » et « partiellement examiné » ne portent PAS le même badge', () => {
		// Sans cette distinction, `detect:index_transition` n'ayant jamais tourné, les six
		// projets viraient au violet et l'écran ne différenciait plus rien.
		const jamais = classifyProject(card({ slug: 'jamais', detectors: NEVER }));
		const partiel = classifyProject(card({ slug: 'partiel', detectors: PARTIAL }));
		expect(jamais.state).toBe('unknown');
		expect(partiel.state).toBe('watch');
		expect(partiel.state).not.toBe(jamais.state);
		// Et l'ordre reste celui de l'urgence : ne rien savoir passe devant.
		expect(rankProjects([partiel, jamais]).map((c) => c.slug)).toEqual(['jamais', 'partiel']);
	});

	it('nomme le domaine, pas le type de job', () => {
		expect(detectorLabel('detect:index_transition')).toBe('transitions d’indexation');
		// Un détecteur inconnu s'affiche tel quel plutôt que de disparaître de la phrase.
		expect(detectorLabel('detect:futur')).toBe('detect:futur');
	});
});

describe('acceptation : une intégration cassée est distincte d’une baisse de performance', () => {
	it('deux projets, deux causes, deux verdicts qui ne se confondent pas', () => {
		const cassé = classifyProject(
			card({
				slug: 'cassé',
				integrations: [integration({ status: 'error', lastErrorCode: 'invalid_grant' })],
				openBySeverity: {},
				activity: activity()
			})
		);
		const baisse = classifyProject(
			card({
				slug: 'baisse',
				integrations: [integration()],
				openBySeverity: { critical: 3 },
				activity: activity({ aggravated: 2 })
			})
		);

		expect(cassé.state).toBe('broken');
		expect(cassé.pipeline.state).toBe('broken');
		expect(cassé.signal.state).toBe('unknown'); // et surtout PAS 'ok'
		expect(cassé.headline).toContain('Collecte');

		expect(baisse.state).toBe('at_risk');
		expect(baisse.pipeline.state).toBe('ok');
		expect(baisse.signal.state).toBe('at_risk');
		expect(baisse.headline).toContain('Performance');

		// Le test de la confusion : les deux ne partagent NI l'état, NI l'axe, NI la phrase.
		expect(cassé.state).not.toBe(baisse.state);
		expect(cassé.headline).not.toBe(baisse.headline);
	});

	it('un projet sain nomme ses deux axes, sans prétendre qu\'il n\'y a rien à faire', () => {
		const ok = classifyProject(card({ openBySeverity: { info: 4, low: 2 } }));
		expect(ok.state).toBe('ok');
		expect(ok.headline).toBe('Collecte et performance au vert');
		// Le verdict porte sur la DONNÉE et rien d'autre : six findings ouverts coexistent avec
		// un état sain, donc la phrase ne peut pas dire « rien à traiter » sans mentir sur ce
		// qu'elle a regardé.
		expect(ok.openTotal).toBe(6);
	});

	it('chaque carte porte ses compteurs, chacun avec son filtre', () => {
		const c = classifyProject(
			card({ activity: activity({ created: 2, aggravated: 1 }), proposalsPending: 3, jobsDead: 1 })
		);
		const labels = c.counters.map((x) => x.label);
		expect(labels).toContain('nouveaux');
		expect(labels).toContain('à valider');
		expect(labels).toContain('dead-letter');
		const nouveaux = c.counters.find((x) => x.label === 'nouveaux')!;
		expect(nouveaux.count).toBe(2);
		// Round-trip plutôt qu'égalité de chaîne : `URLSearchParams` encode l'espace du
		// format DB en `+`, que le parsing de l'URL côté serveur redécode en espace. C'est
		// la borne RELUE qui doit être exacte, pas son encodage.
		const relu = new URL(nouveaux.href!, 'https://x').searchParams.get('since');
		expect(relu).toBe(SINCE);
	});

	it('sans dead-letter, le compteur n’encombre pas la carte', () => {
		const c = classifyProject(card({ jobsDead: 0 }));
		expect(c.counters.map((x) => x.label)).not.toContain('dead-letter');
	});
});

describe('priorisation : ordre total, « inconnu » avant « à surveiller »', () => {
	it('classe cassé → à risque → inconnu → à surveiller → ok', () => {
		expect(stateRank('broken')).toBeLessThan(stateRank('at_risk'));
		expect(stateRank('at_risk')).toBeLessThan(stateRank('unknown'));
		// Ne pas savoir est plus urgent qu'un signal faible connu : un projet muet est le
		// seul qui puisse cacher n'importe quoi.
		expect(stateRank('unknown')).toBeLessThan(stateRank('watch'));
		expect(stateRank('watch')).toBeLessThan(stateRank('ok'));
	});

	it('l’ordre est TOTAL : deux projets équivalents ne permutent pas', () => {
		const a = classifyProject(card({ slug: 'bravo', openBySeverity: { critical: 1 } }));
		const b = classifyProject(card({ slug: 'alpha', openBySeverity: { critical: 1 } }));
		expect(rankProjects([a, b]).map((c) => c.slug)).toEqual(['alpha', 'bravo']);
		expect(rankProjects([b, a]).map((c) => c.slug)).toEqual(['alpha', 'bravo']);
	});

	it('à état égal, le plus de critiques passe devant', () => {
		const peu = classifyProject(card({ slug: 'peu', openBySeverity: { critical: 1 } }));
		const beaucoup = classifyProject(card({ slug: 'beaucoup', openBySeverity: { critical: 5 } }));
		expect(rankProjects([peu, beaucoup]).map((c) => c.slug)).toEqual(['beaucoup', 'peu']);
	});

	it('les projets à traiter excluent les sains', () => {
		const sain = classifyProject(card({ slug: 'sain' }));
		const cassé = classifyProject(
			card({ slug: 'cassé', integrations: [integration({ status: 'error' })] })
		);
		const todo = projectsNeedingAction([sain, cassé]);
		expect(todo.map((c) => c.slug)).toEqual(['cassé']);
	});
});

describe('santé du portefeuille', () => {
	it('vaut le PIRE état représenté, jamais une moyenne', () => {
		const cards = [
			classifyProject(card({ slug: 'a' })),
			classifyProject(card({ slug: 'b' })),
			classifyProject(card({ slug: 'c', integrations: [integration({ status: 'error' })] }))
		];
		const p = summarizePortfolio(cards);
		// Cinq projets sains ne compensent pas une collecte morte : ils la diluent.
		expect(p.worst).toBe('broken');
		expect(p.total).toBe(3);
		expect(p.needingAction).toBe(1);
		expect(p.byState.ok).toBe(2);
		expect(p.byState.broken).toBe(1);
	});

	it('aucun projet vaut « unknown », pas « ok »', () => {
		expect(summarizePortfolio([]).worst).toBe('unknown');
	});
});

describe('pause : une décision, jamais une panne (DASH-003 lot 2)', () => {
	it('résume un gel projet : toutes les cadences câblées, donc `full`', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		expect(p).not.toBeNull();
		expect(p!.scope).toBe('project');
		expect(p!.full).toBe(true);
		// `hourly` et `monthly` ont un catalogue VIDE : elles ne sont pas comptées, sans quoi
		// `full` serait inatteignable et le badge n'apparaîtrait jamais.
		expect(p!.cadences).toEqual(['daily', 'weekly']);
		expect(p!.reason).toContain('contrat en pause');
		expect(p!.actor).toBe('user:contact@jonlabs.ch');
	});

	it('nomme la portée la PLUS LARGE : c’est elle qu’il faudra lever', () => {
		const p = pauseOf([
			pauseRow({ id: 'e1', scope: 'project_cadence', cadence: 'weekly' }),
			pauseRow({ id: 'e2', scope: 'project' })
		]);
		// Proposer « Reprendre » sur la cadence alors qu'un gel projet subsiste ferait
		// cliquer dans le vide (`resolveCadencePause`, union et non préséance).
		expect(p!.scope).toBe('project');
	});

	it('⭐ une pause sur une cadence NON CÂBLÉE ne suspend rien', () => {
		// `monthly` a un catalogue vide : la suspendre est une décision sans effet. La colorer
		// signalerait un arrêt là où rien ne tournait.
		expect(pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'monthly' })])).toBeNull();
	});

	it('une cadence DÉSACTIVÉE est hors du décompte (configuration ≠ décision)', () => {
		const p = pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'weekly' })], {
			enabled: { ...ALL_CADENCES_ENABLED, weekly: false }
		});
		expect(p).toBeNull();
	});

	it('une pause partielle n’est pas `full`', () => {
		const p = pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'weekly' })]);
		expect(p!.full).toBe(false);
		expect(p!.cadences).toEqual(['weekly']);
	});

	it('⭐ l’expiration est DÉRIVÉE — jamais réimplémentée ici', () => {
		const rows = [pauseRow({ until: '2026-07-25 11:00:00' })];
		// Échéance passée à l'instant de lecture : `derivePauseStates` l'écarte, et ce module
		// n'a aucune seconde comparaison de `until` qui pourrait la contredire.
		expect(pauseOf(rows)).toBeNull();
		expect(pauseOf(rows, { now: new Date('2026-07-25T10:00:00Z') })).not.toBeNull();
	});

	it('une pause d’un AUTRE projet ne suspend pas celui-ci', () => {
		expect(pauseOf([pauseRow({ projectId: 'p2' })])).toBeNull();
	});

	it('une reprise lève la pause sans rien effacer du journal', () => {
		const p = pauseOf([
			pauseRow({ id: 'e1', createdAt: '2026-07-20 08:00:00' }),
			pauseRow({ id: 'e2', eventType: 'resumed', createdAt: '2026-07-21 08:00:00' })
		]);
		expect(p).toBeNull();
	});
});

describe('pause : diagnostic suspendu, par DÉTECTEUR', () => {
	it('⭐ suspendre le hebdo ne suspend pas un détecteur que le quotidien enfile aussi', () => {
		const p = pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'weekly' })]);
		// `detect:keyword_opportunity` n'est qu'au catalogue hebdo → suspendu.
		expect(p!.suspendedJobTypes).toContain('detect:keyword_opportunity');
		// `detect:index_transition` est au catalogue `daily` ET `weekly` → il tournera demain.
		expect(p!.suspendedJobTypes).not.toContain('detect:index_transition');
	});

	it('une coupure provider suspend les détecteurs par PROPAGATION (JOB-004)', () => {
		const p = pauseOf([
			pauseRow({ scope: 'provider', projectId: null, provider: 'gsc', reason: 'quota épuisé' })
		]);
		expect(p).not.toBeNull();
		// ⚠️ Une pause provider ne suspend AUCUNE cadence : le run s'ouvre, seuls ses jobs sautent.
		expect(p!.cadences).toEqual([]);
		expect(p!.full).toBe(false);
		expect(p!.providers).toEqual(['gsc']);
		// …mais un prérequis OBLIGATOIRE mort fait passer son dépendant en `skipped` : aucun
		// détecteur ne sort de Postgres, et pourtant aucun ne tournera. Ne compter que le
		// provider du détecteur lui-même annoncerait un diagnostic qui n'aura pas lieu.
		expect(p!.suspendedJobTypes).toContain('detect:index_transition');
		expect(p!.suspendedJobTypes).toContain('detect:keyword_opportunity');
		// `findings:lifecycle` ne sort pas de Postgres : il n'a aucune raison d'attendre.
		expect(p!.suspendedJobTypes).not.toContain('findings:lifecycle');
	});

	it('la couverture ACQUISE ne baisse pas sous pause', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		const d = deriveDiagnosisCoverage(detectors(), p);
		// Ce qui a été examiné l'a été : la couverture cesse d'être renouvelée, elle ne se
		// rétracte pas. La rabaisser effacerait un passage réel.
		expect(d.state).toBe('full');
		expect(d.suspended.sort()).toEqual(['detect:index_transition', 'detect:keyword_opportunity']);
	});

	it('« suspendu » ne se confond pas avec « jamais planifié »', () => {
		const rien = deriveDiagnosisCoverage([], pauseOf([pauseRow({ scope: 'project' })]));
		expect(rien.expectedCount).toBe(0);
		// Aucun détecteur attendu ici : nommer un domaine suspendu parlerait d'un diagnostic
		// que personne n'attendait de ce projet.
		expect(rien.suspended).toEqual([]);
	});
});

describe('pause : l’axe PIPELINE', () => {
	const STALE = deriveFreshness({
		lastSuccessAt: '2026-07-01 09:00:00',
		now: NOW,
		staleAfterHours: 24 * 10
	});

	it('⭐ une pause EXPLIQUE le retard : on le dit, on ne dégrade pas', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		const v = classifyPipeline({ integrations: [integration()], freshness: STALE, jobsDead: 0, pause: p });
		expect(v.reasons.join(' ')).toContain('collecte suspendue');
		expect(v.reasons.join(' ')).not.toContain('en retard');
		// `unknown` (pause totale), et surtout PAS `degraded` : réparer une décision n'a pas de sens.
		expect(v.state).toBe('unknown');
	});

	it('CONTRE-ÉPREUVE : le MÊME retard sans pause dégrade toujours', () => {
		const v = classifyPipeline({ integrations: [integration()], freshness: STALE, jobsDead: 0 });
		expect(v.state).toBe('degraded');
		expect(v.reasons.join(' ')).toContain('en retard');
	});

	it('CONTRE-ÉPREUVE : une pause qui ne couvre pas la collecte laisse le retard visible', () => {
		// `daily` seule : la collecte GSC hebdomadaire n'en dépend pas.
		const p = pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'daily' })]);
		expect(pauseSuspendsFreshness(p)).toBe(false);
		const v = classifyPipeline({ integrations: [integration()], freshness: STALE, jobsDead: 0, pause: p });
		expect(v.state).toBe('degraded');
		expect(v.reasons.join(' ')).toContain('en retard');
	});

	it('pause totale sur un pipeline sain ⇒ `unknown`, jamais `ok`', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		const v = classifyPipeline({
			integrations: [integration()],
			freshness: deriveFreshness({ lastSuccessAt: '2026-07-24 09:00:00', now: NOW, staleAfterHours: 240 }),
			jobsDead: 0,
			pause: p
		});
		expect(v.state).toBe('unknown');
		expect(v.reasons[0]).toContain('suspendue par décision');
	});

	it('⭐ une pause ne RÉPARE rien : un credential révoqué reste `broken`', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		const v = classifyPipeline({
			integrations: [integration({ status: 'revoked' })],
			freshness: STALE,
			jobsDead: 0,
			pause: p
		});
		// Le jour où on reprend, la panne est encore là. L'ordre des règles est celui de ce
		// qui SURVIT à la reprise.
		expect(v.state).toBe('broken');
	});

	it('un job en dead-letter reste une dégradation sous pause', () => {
		const p = pauseOf([pauseRow({ scope: 'project' })]);
		const v = classifyPipeline({
			integrations: [integration()],
			freshness: deriveFreshness({ lastSuccessAt: '2026-07-24 09:00:00', now: NOW, staleAfterHours: 240 }),
			jobsDead: 2,
			pause: p
		});
		// Il ne repartira pas parce qu'on a suspendu la cadence : il est DÉJÀ en file.
		expect(v.state).toBe('degraded');
	});
});

describe('pause : la carte et le portefeuille', () => {
	const GEL = [pauseRow({ scope: 'project' })];

	it('⭐ CONTRE-ÉPREUVE : une pause sans effet rend une carte STRICTEMENT identique', () => {
		const sans = classifyProject(card());
		const avec = classifyProject(
			card({ pause: pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'monthly' })]) })
		);
		expect(avec).toEqual(sans);
	});

	it('un gel total porte le badge `paused` et nomme la décision', () => {
		const c = classifyProject(card({ pause: pauseOf(GEL) }));
		expect(c.state).toBe('paused');
		expect(c.headline).toContain('Suspendu');
		expect(c.headline).toContain('contrat en pause');
		expect(c.headline).toContain('user:contact@jonlabs.ch');
		expect(c.headline).toContain('projet gelé');
		expect(c.pause?.full).toBe(true);
	});

	it('⭐ ni `ok` ni `broken` : la doctrine, assertée frontalement', () => {
		const c = classifyProject(card({ pause: pauseOf(GEL) }));
		expect(c.state).not.toBe('ok');
		expect(c.state).not.toBe('broken');
	});

	it('une panne réelle sous pause garde le badge de la PANNE', () => {
		const c = classifyProject(
			card({ integrations: [integration({ status: 'error' })], pause: pauseOf(GEL) })
		);
		expect(c.state).toBe('broken');
	});

	it('⭐ le badge `paused` ne MASQUE pas un problème encore actif', () => {
		// Dead-letter → le pipeline reste `degraded` (pas `unknown`), donc le signal garde le
		// droit de conclure, et le critique déjà ouvert reprend la main sur la décision.
		const c = classifyProject(
			card({ jobsDead: 1, openBySeverity: { critical: 1 }, pause: pauseOf(GEL) })
		);
		expect(c.state).toBe('at_risk');
		expect(c.pause?.full).toBe(true);
	});

	it('sous gel total, un critique déjà ouvert reste DIT même si le badge est `paused`', () => {
		const c = classifyProject(card({ openBySeverity: { critical: 2 }, pause: pauseOf(GEL) }));
		expect(c.state).toBe('paused');
		// Même doctrine que le pipeline cassé : ce qui est POSITIVEMENT su ne disparaît pas.
		expect(c.signal.reasons.join(' ')).toContain('critique déjà ouvert');
		expect(c.openTotal).toBe(2);
	});

	it('une pause partielle ne repeint pas le projet, mais se DIT', () => {
		const c = classifyProject({
			...card(),
			pause: pauseOf([pauseRow({ scope: 'project_cadence', cadence: 'weekly' })])
		});
		expect(c.state).not.toBe('paused');
		expect(c.signal.reasons.join(' ')).toContain('diagnostic suspendu');
	});

	it('`paused` passe APRÈS `ok` dans l’ordre : un arrêt volontaire ne prend pas la tête', () => {
		expect(stateRank('ok')).toBeLessThan(stateRank('paused'));
		expect(needsAction('paused')).toBe(false);
		expect(needsAction('unknown')).toBe(true);
	});

	it('les projets « à traiter » excluent les suspendus', () => {
		const gelé = classifyProject(card({ slug: 'gele', pause: pauseOf(GEL) }));
		const cassé = classifyProject(
			card({ slug: 'casse', integrations: [integration({ status: 'error' })] })
		);
		expect(projectsNeedingAction([gelé, cassé]).map((c) => c.slug)).toEqual(['casse']);
	});

	it('un projet suspendu ne teinte pas le portefeuille…', () => {
		const p = summarizePortfolio([
			classifyProject(card({ slug: 'a' })),
			classifyProject(card({ slug: 'b', pause: pauseOf(GEL) }))
		]);
		expect(p.worst).toBe('ok');
		expect(p.byState.paused).toBe(1);
		expect(p.needingAction).toBe(0);
	});

	it('…mais un parc ENTIÈREMENT suspendu n’est pas « au vert »', () => {
		const p = summarizePortfolio([
			classifyProject(card({ slug: 'a', pause: pauseOf(GEL) })),
			classifyProject(card({ slug: 'b', pause: pauseOf(GEL) }))
		]);
		expect(p.worst).toBe('paused');
		expect(p.byState.paused).toBe(2);
	});
});

describe('coûts : un gate inerte, pas un zéro', () => {
	it('dit « non instrumenté » quand aucun run ne porte de coût', () => {
		const s = summarizeCosts([{ costJson: null }, { costJson: null }]);
		expect(s.instrumented).toBe(false);
		if (!s.instrumented) {
			expect(s.reason).toBe('not_instrumented');
			expect(s.detail).toContain('cost_json');
		}
	});

	it('se réveille SEUL dès qu’un run porte un coût', () => {
		const s = summarizeCosts([
			{ costJson: JSON.stringify({ tokens: 1200, calls: 3 }) },
			{ costJson: JSON.stringify({ tokens: 800 }) },
			{ costJson: null }
		]);
		expect(s.instrumented).toBe(true);
		if (s.instrumented) {
			expect(s.runs).toBe(2);
			expect(s.totals.tokens).toBe(2000);
			expect(s.totals.calls).toBe(3);
		}
	});

	it('un cost_json cassé ne coûte pas l’accueil entier', () => {
		const s = summarizeCosts([{ costJson: '{pas du json' }, { costJson: '"une chaîne"' }]);
		expect(s.instrumented).toBe(false);
	});
});
