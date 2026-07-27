import { describe, it, expect } from 'vitest';
import {
	DEFAULT_PUBLISH_DEADLINE_MINUTES,
	PUBLICATION_SCHEMA_VERSION,
	PUBLICATION_STATUSES,
	READINESS_STATES,
	classifyProjectReadiness,
	currentPublicationSlot,
	decidePublication,
	deriveSlo,
	renderPublicationAnnouncement,
	resolvePublishDeadlineMinutes,
	summarizeReadiness,
	type ProjectRunInput
} from './report-publication-state.js';
import { SCHEDULE_DEFAULTS, type CadenceSpec } from './schedule-state.js';
import { dbTimestampToMs, toDbTimestamp } from './timestamps.js';

const at = (s: string) => Date.parse(s);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Lundi 27 juillet 2026, 09:00 Europe/Zurich (CEST, donc 07:00 UTC). */
const SLOT_MS = at('2026-07-27T07:00:00Z');
const SLOT = '2026-07-27T09:00';

function project(over: Partial<ProjectRunInput> = {}): ProjectRunInput {
	return { projectSlug: 'alpha', runStatus: 'success', runId: 'run-1', paused: false, ...over };
}

function decide(over: Partial<Parameters<typeof decidePublication>[0]> = {}) {
	return decidePublication({
		periodSlot: SLOT,
		slotAtMs: SLOT_MS,
		now: SLOT_MS + 5 * MINUTE,
		deadlineMinutes: DEFAULT_PUBLISH_DEADLINE_MINUTES,
		projects: [project()],
		alreadyPublished: false,
		...over
	});
}

// ── Échéance réglable ───────────────────────────────────────────────

describe('resolvePublishDeadlineMinutes', () => {
	it('défaut = 60 min, soit lundi 10:00 (SLO §17.3)', () => {
		expect(DEFAULT_PUBLISH_DEADLINE_MINUTES).toBe(60);
		expect(resolvePublishDeadlineMinutes(null)).toBe(60);
		expect(resolvePublishDeadlineMinutes('')).toBe(60);
		expect(resolvePublishDeadlineMinutes(undefined)).toBe(60);
	});

	it('accepte un nombre nu et un objet JSON', () => {
		expect(resolvePublishDeadlineMinutes('30')).toBe(30);
		expect(resolvePublishDeadlineMinutes('{"minutes":90}')).toBe(90);
	});

	it('toute valeur illisible ou absurde retombe sur le défaut (jamais une levée)', () => {
		// Une échéance qui ferait lever empêcherait TOUTE publication : le pire cas doit
		// rester « tourner au défaut documenté ».
		expect(resolvePublishDeadlineMinutes('rien')).toBe(60);
		expect(resolvePublishDeadlineMinutes('0')).toBe(60);
		expect(resolvePublishDeadlineMinutes('-15')).toBe(60);
		expect(resolvePublishDeadlineMinutes('99999')).toBe(60);
		expect(resolvePublishDeadlineMinutes('{"minutes":"abc"}')).toBe(60);
	});

	it('tronque une valeur fractionnaire', () => {
		expect(resolvePublishDeadlineMinutes('45.9')).toBe(45);
	});
});

// ── Le créneau ──────────────────────────────────────────────────────

describe('currentPublicationSlot', () => {
	const spec = SCHEDULE_DEFAULTS.weekly;

	it('rend le lundi 09:00 local courant, jamais celui à venir', () => {
		const slot = currentPublicationSlot({ now: SLOT_MS + 3 * HOUR, spec });
		expect(slot?.localSlot).toBe(SLOT);
		expect(slot?.instantMs).toBe(SLOT_MS);
	});

	it('la veille du créneau, rend le créneau de la semaine PRÉCÉDENTE', () => {
		// Dimanche : le lundi de demain n'a pas eu lieu, et publier son rapport annoncerait
		// une semaine que rien n'a encore mesurée.
		const slot = currentPublicationSlot({ now: SLOT_MS - 12 * HOUR, spec });
		expect(slot?.localSlot).toBe('2026-07-20T09:00');
	});

	it('une seconde avant le créneau, ce n’est pas encore lui', () => {
		const slot = currentPublicationSlot({ now: SLOT_MS - 1000, spec });
		expect(slot?.localSlot).toBe('2026-07-20T09:00');
	});

	it('reste 09:00 LOCAL des deux côtés du changement d’heure', () => {
		// Hiver (CET, +1) : 09:00 local = 08:00 UTC. Été (CEST, +2) : 07:00 UTC. Le créneau ne
		// bouge pas, son instant si — c'est tout l'intérêt de la clé locale.
		const winter = currentPublicationSlot({ now: at('2026-01-19T10:00:00Z'), spec });
		expect(winter?.localSlot).toBe('2026-01-19T09:00');
		expect(winter?.instantMs).toBe(at('2026-01-19T08:00:00Z'));

		const summer = currentPublicationSlot({ now: at('2026-07-27T10:00:00Z'), spec });
		expect(summer?.instantMs).toBe(at('2026-07-27T07:00:00Z'));
	});

	it('rend null si la cadence hebdo est désactivée', () => {
		const off: CadenceSpec = { ...spec, enabled: false };
		expect(currentPublicationSlot({ now: SLOT_MS + HOUR, spec: off })).toBeNull();
	});

	it('un créneau déplacé (jeudi 14:30) est suivi sans règle recopiée', () => {
		const thursday: CadenceSpec = { ...spec, weekday: 4, hour: 14, minute: 30 };
		const slot = currentPublicationSlot({ now: at('2026-07-31T12:00:00Z'), spec: thursday });
		expect(slot?.localSlot).toBe('2026-07-30T14:30');
	});
});

// ── L'état d'un projet ──────────────────────────────────────────────

describe('classifyProjectReadiness', () => {
	it('un run réussi est prêt', () => {
		expect(classifyProjectReadiness(project({ runStatus: 'success' }))).toBe('ready');
	});

	it('partial, failed et cancelled sont TERMINAUX et dégradés', () => {
		for (const status of ['partial', 'failed', 'cancelled']) {
			expect(classifyProjectReadiness(project({ runStatus: status }))).toBe('degraded');
		}
	});

	it('queued et running sont une attente', () => {
		expect(classifyProjectReadiness(project({ runStatus: 'queued' }))).toBe('waiting');
		expect(classifyProjectReadiness(project({ runStatus: 'running' }))).toBe('waiting');
	});

	it('aucun run + aucune pause = ABSENT (pas « en attente »)', () => {
		// « Lent » et « jamais planifié » demandent deux gestes : attendre, ou aller voir
		// pourquoi le scheduler n'a rien produit.
		expect(classifyProjectReadiness(project({ runStatus: null, runId: null }))).toBe('missing');
	});

	it('aucun run + cadence suspendue = paused', () => {
		expect(
			classifyProjectReadiness(project({ runStatus: null, runId: null, paused: true }))
		).toBe('paused');
	});

	it('⭐ un run EXISTANT l’emporte sur une pause posée depuis', () => {
		// Une pause de mercredi ne rétroactive pas le lundi : le run a tourné, ses steps ont
		// écrit, le rapport doit en parler.
		expect(classifyProjectReadiness(project({ runStatus: 'success', paused: true }))).toBe(
			'ready'
		);
		expect(classifyProjectReadiness(project({ runStatus: 'failed', paused: true }))).toBe(
			'degraded'
		);
	});

	it('un statut inconnu est traité comme non terminal (on attend, on ne conclut pas)', () => {
		expect(classifyProjectReadiness(project({ runStatus: 'schrödinger' }))).toBe('waiting');
	});

	it('le vocabulaire des états est fermé', () => {
		expect([...READINESS_STATES]).toEqual(['ready', 'degraded', 'waiting', 'missing', 'paused']);
	});
});

// ── La préparation du créneau ───────────────────────────────────────

describe('summarizeReadiness', () => {
	const readiness = (projects: ProjectRunInput[]) =>
		summarizeReadiness({ periodSlot: SLOT, deadlineMinutes: 60, projects });

	it('les projets suspendus sortent du DÉNOMINATEUR, et restent nommés', () => {
		const r = readiness([
			project({ projectSlug: 'alpha' }),
			project({ projectSlug: 'beta', runStatus: null, runId: null, paused: true, pauseReason: 'client gelé' })
		]);
		expect(r.expected).toBe(1);
		expect(r.paused).toEqual(['beta']);
		expect(r.blockers).toEqual([]);
		// Écarté n'est pas tu : la ligne porte sa raison.
		expect(r.byProject.find((p) => p.projectSlug === 'beta')?.note).toContain('client gelé');
	});

	it('une pause sans raison journalisée le DIT au lieu de laisser un blanc', () => {
		const r = readiness([project({ runStatus: null, runId: null, paused: true })]);
		expect(r.byProject[0].note).toContain('sans raison journalisée');
	});

	it('waiting et missing sont des bloquants, degraded n’en est pas un', () => {
		const r = readiness([
			project({ projectSlug: 'a', runStatus: 'running' }),
			project({ projectSlug: 'b', runStatus: null, runId: null }),
			project({ projectSlug: 'c', runStatus: 'partial' })
		]);
		expect(r.blockers).toEqual(['a', 'b']);
		expect(r.degraded).toBe(1);
		// Un run dégradé est un INCIDENT, même s'il ne retient pas la publication.
		expect(r.incidents.map((i) => i.kind).sort()).toEqual(['degraded', 'missing', 'waiting']);
	});

	it('l’ordre est TOTAL (par slug) : deux lectures rendent le même JSON', () => {
		const a = readiness([project({ projectSlug: 'zeta' }), project({ projectSlug: 'alpha' })]);
		const b = readiness([project({ projectSlug: 'alpha' }), project({ projectSlug: 'zeta' })]);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a.byProject.map((p) => p.projectSlug)).toEqual(['alpha', 'zeta']);
	});

	it('un projet prêt ne porte AUCUNE note (rien à signaler ≠ note vide)', () => {
		expect(readiness([project()]).byProject[0].note).toBeNull();
	});
});

// ── La décision ─────────────────────────────────────────────────────

describe('decidePublication', () => {
	it('publie complete quand tous les runs attendus ont réussi', () => {
		const d = decide({ projects: [project({ projectSlug: 'a' }), project({ projectSlug: 'b' })] });
		expect(d.action).toBe('publish');
		expect(d.status).toBe('complete');
		expect(d.reason).toBe('all_steps_terminal');
		expect(d.deadlineReached).toBe(false);
	});

	it('publie partial dès qu’un run attendu est dégradé, sans attendre l’échéance', () => {
		// Terminal veut dire « plus rien à attendre » : retenir le rapport une heure de plus
		// ne changerait pas un run mort en run réussi.
		const d = decide({
			projects: [project({ projectSlug: 'a' }), project({ projectSlug: 'b', runStatus: 'failed' })]
		});
		expect(d.action).toBe('publish');
		expect(d.status).toBe('partial');
		expect(d.reason).toBe('all_steps_terminal');
	});

	it('ATTEND tant qu’un step est en vol et que l’échéance n’est pas atteinte', () => {
		const d = decide({ projects: [project({ runStatus: 'running' })] });
		expect(d.action).toBe('wait');
		expect(d.status).toBeNull();
		expect(d.reason).toBe('awaiting_steps');
		expect(d.readiness.blockers).toEqual(['alpha']);
	});

	it('⭐ publie partial À L’ÉCHÉANCE, même avec des steps en vol', () => {
		// « Attendre les steps obligatoires AVEC deadline » : sans borne, un run bloqué
		// suffirait à ce que le rapport ne sorte jamais.
		const d = decide({
			projects: [project({ runStatus: 'running' })],
			now: SLOT_MS + 60 * MINUTE
		});
		expect(d.action).toBe('publish');
		expect(d.status).toBe('partial');
		expect(d.reason).toBe('deadline_reached');
		expect(d.deadlineReached).toBe(true);
	});

	it('l’échéance est inclusive à la seconde près (60 min pile = atteinte)', () => {
		expect(decide({ now: SLOT_MS + 60 * MINUTE - 1 }).deadlineReached).toBe(false);
		expect(decide({ now: SLOT_MS + 60 * MINUTE }).deadlineReached).toBe(true);
	});

	it('dueAtMs suit l’échéance configurée', () => {
		expect(decide({ deadlineMinutes: 90 }).dueAtMs).toBe(SLOT_MS + 90 * MINUTE);
	});

	it('n’écrit rien avant le créneau, quel que soit l’état du parc', () => {
		const d = decide({ now: SLOT_MS - 1000 });
		expect(d.action).toBe('wait');
		expect(d.reason).toBe('slot_not_reached');
	});

	it('un créneau déjà publié sort AVANT tout le reste', () => {
		const d = decide({
			alreadyPublished: true,
			projects: [project({ runStatus: 'running' })],
			now: SLOT_MS + 10 * HOUR
		});
		expect(d.action).toBe('already_published');
		expect(d.status).toBeNull();
		expect(d.reason).toBe('already_published');
	});

	it('⭐ un parc entièrement suspendu ne peut PAS être complete', () => {
		// Sans cette règle, `blockers = []` et `degraded = 0` sur zéro projet examiné
		// annonceraient un rapport complet : la faute DASH-002 (« jamais regardé ≠ rien à
		// signaler ») portée au statut de publication.
		const d = decide({
			projects: [
				project({ projectSlug: 'a', runStatus: null, runId: null, paused: true }),
				project({ projectSlug: 'b', runStatus: null, runId: null, paused: true })
			]
		});
		expect(d.action).toBe('publish');
		expect(d.status).toBe('partial');
		expect(d.readiness.expected).toBe(0);
		expect(d.readiness.paused).toEqual(['a', 'b']);
	});

	it('un parc VIDE ne peut pas être complete non plus', () => {
		const d = decide({ projects: [] });
		expect(d.status).toBe('partial');
		expect(d.readiness.expected).toBe(0);
	});

	it('un projet suspendu ne fait PAS tomber un parc par ailleurs prêt', () => {
		const d = decide({
			projects: [
				project({ projectSlug: 'a' }),
				project({ projectSlug: 'b', runStatus: null, runId: null, paused: true })
			]
		});
		// Le scheduler ne lui a rien planifié : attendre son run serait attendre ce que
		// personne n'a demandé.
		expect(d.status).toBe('complete');
	});

	it('le statut ne prend que deux valeurs, et jamais sur une attente', () => {
		expect([...PUBLICATION_STATUSES]).toEqual(['complete', 'partial']);
		expect(PUBLICATION_SCHEMA_VERSION).toBe(1);
		expect(decide({ projects: [project({ runStatus: 'queued' })] }).status).toBeNull();
	});

	it('la préparation est rendue MÊME en attente (l’attente doit être motivée)', () => {
		const d = decide({ projects: [project({ runStatus: 'queued' })] });
		expect(d.readiness.byProject).toHaveLength(1);
		expect(d.readiness.incidents[0].kind).toBe('waiting');
	});
});

// ── Le SLO ──────────────────────────────────────────────────────────

describe('deriveSlo', () => {
	const slo = (publishedAt: string, dueAt = '2026-07-27 08:00:00') =>
		deriveSlo({
			slotAt: '2026-07-27 07:00:00',
			dueAt,
			publishedAt,
			parseMs: dbTimestampToMs
		});

	it('tenu si la publication précède l’échéance', () => {
		const v = slo('2026-07-27 07:12:00');
		expect(v.met).toBe(true);
		expect(v.lateMs).toBe(0);
		expect(v.latencyMs).toBe(12 * MINUTE);
	});

	it('l’échéance pile est TENUE (avant 10:00 inclusivement)', () => {
		expect(slo('2026-07-27 08:00:00').met).toBe(true);
	});

	it('manqué d’une seconde est manqué, et le retard est chiffré', () => {
		const v = slo('2026-07-27 08:00:01');
		expect(v.met).toBe(false);
		expect(v.lateMs).toBe(1000);
	});

	it('un rattrapage du mercredi est mesuré, pas masqué', () => {
		const v = slo('2026-07-29 06:00:00');
		expect(v.met).toBe(false);
		expect(Math.round(v.lateMs / HOUR)).toBe(46);
		expect(Math.round(v.latencyMs / HOUR)).toBe(47);
	});

	it('⭐ la comparaison est LEXICALE, donc sans piège de fuseau', () => {
		// `new Date('2026-07-27 08:00:00')` serait lu en heure LOCALE (Zurich) : à Zurich,
		// dériver le verdict d'un parse naïf le ferait basculer deux fois l'an.
		expect(toDbTimestamp(new Date(SLOT_MS))).toBe('2026-07-27 07:00:00');
		expect(dbTimestampToMs('2026-07-27 07:00:00')).toBe(SLOT_MS);
		expect(slo('2026-07-27 07:59:59').met).toBe(true);
	});

	it('une valeur illisible ne fabrique pas un retard négatif ou NaN', () => {
		const v = deriveSlo({
			slotAt: 'n’importe quoi',
			dueAt: '2026-07-27 08:00:00',
			publishedAt: '2026-07-27 07:30:00',
			parseMs: dbTimestampToMs
		});
		expect(v.met).toBe(true);
		expect(v.latencyMs).toBe(0);
	});
});

// ── L'annonce ───────────────────────────────────────────────────────

describe('renderPublicationAnnouncement', () => {
	const announce = (projects: ProjectRunInput[], status: 'complete' | 'partial' = 'partial') => {
		const readiness = summarizeReadiness({ periodSlot: SLOT, deadlineMinutes: 60, projects });
		return renderPublicationAnnouncement({
			periodSlot: SLOT,
			status,
			slo: deriveSlo({
				slotAt: '2026-07-27 07:00:00',
				dueAt: '2026-07-27 08:00:00',
				publishedAt: '2026-07-27 07:10:00',
				parseMs: dbTimestampToMs
			}),
			readiness,
			headline: 'Semaine du 20 au 27 juillet : 3 findings nouveaux.'
		});
	};

	it('annonce disponibilité, statut et SLO dès la première ligne', () => {
		const a = announce([project()], 'complete');
		expect(a.headline).toContain(SLOT);
		expect(a.headline).toContain('COMPLETE');
		expect(a.headline).toContain('SLO tenu');
	});

	it('reprend la phrase du rapport, sans la réécrire', () => {
		expect(announce([project()]).lines[1]).toBe(
			'Semaine du 20 au 27 juillet : 3 findings nouveaux.'
		);
	});

	it('dit explicitement l’absence d’incident (jamais un silence)', () => {
		const a = announce([project()], 'complete');
		expect(a.hasIncidents).toBe(false);
		expect(a.lines.join('\n')).toContain('Aucun incident');
	});

	it('sépare les pauses (décision) des incidents (panne)', () => {
		const a = announce([
			project({ projectSlug: 'a', runStatus: 'failed' }),
			project({ projectSlug: 'b', runStatus: null, runId: null, paused: true, pauseReason: 'gelé' })
		]);
		const text = a.lines.join('\n');
		expect(a.hasIncidents).toBe(true);
		expect(text).toContain('Écartés par une pause (décision, pas incident) : b');
		expect(text).toContain('a — run hebdo failed');
		// Le projet suspendu n'apparaît PAS dans la liste des incidents.
		expect(text.split('Incidents')[1]).not.toContain(' b —');
	});

	it('chiffre le retard quand le SLO est manqué', () => {
		const readiness = summarizeReadiness({ periodSlot: SLOT, deadlineMinutes: 60, projects: [project()] });
		const a = renderPublicationAnnouncement({
			periodSlot: SLOT,
			status: 'partial',
			slo: deriveSlo({
				slotAt: '2026-07-27 07:00:00',
				dueAt: '2026-07-27 08:00:00',
				publishedAt: '2026-07-27 08:30:00',
				parseMs: dbTimestampToMs
			}),
			readiness,
			headline: 'peu importe'
		});
		expect(a.headline).toContain('SLO manqué de 30 min');
	});

	it('⭐ n’a d’autre paramètre que ce qui est persisté', () => {
		// Même discipline que `renderWeeklyReportText` : sans base, sans horloge, sans LLM,
		// l'annonce ne peut rien affirmer que la ligne publiée ne porte pas.
		const a = announce([project({ projectSlug: 'a' }), project({ projectSlug: 'b', runStatus: 'partial' })]);
		expect(a.lines.join('\n')).toContain(
			'Projets attendus : 2 · prêts 1 · dégradés 1 · en attente 0 · absents 0'
		);
	});
});
