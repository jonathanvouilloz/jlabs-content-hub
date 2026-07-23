import { describe, it, expect } from 'vitest';
import {
	ACTION_LABEL,
	LEVEL_LABEL,
	LEVEL_APPROVER,
	RISK_LABEL,
	PROPOSAL_STATUS_LABEL,
	FINDING_STATUS_LABEL,
	FINDING_TYPE_LABEL,
	FINDING_EVENT_LABEL,
	SEVERITY_LABEL,
	shortHash,
	priorityBand,
	prettyJson
} from './proposal-format.js';
// Imports RELATIFS, comme `job-format.test.ts` : l'alias `$lib` n'est pas résolu
// dans ce contexte de test, et ces vocabulaires vivent côté serveur — c'est
// justement ce que ce fichier vérifie (aucun terme sans traduction).
import { PROPOSAL_ACTION_TYPES } from '../server/proposer-state.js';
import { PROPOSAL_STATUSES, APPROVAL_LEVELS } from '../server/proposal-state.js';
import {
	FINDING_STATUSES,
	FINDING_TYPES,
	FINDING_EVENT_TYPES,
	FINDING_SEVERITIES
} from '../server/finding-state.js';

// Ces tests ne vérifient pas la beauté des libellés : ils vérifient qu'AUCUN mot du
// vocabulaire ne sort de l'écran sous sa forme technique. Un `crawled_not_indexed`
// affiché tel quel n'est pas une régression visuelle, c'est une information perdue.
describe('couverture du vocabulaire (aucun terme brut à l’écran)', () => {
	it('toutes les actions ont un libellé', () => {
		for (const t of PROPOSAL_ACTION_TYPES) expect(ACTION_LABEL[t]).toBeTruthy();
	});
	it('tous les statuts de proposition ont un libellé', () => {
		for (const s of PROPOSAL_STATUSES) expect(PROPOSAL_STATUS_LABEL[s]).toBeTruthy();
	});
	it('tous les niveaux disent ce qu’ils autorisent ET qui peut les accorder', () => {
		for (const l of APPROVAL_LEVELS) {
			expect(LEVEL_LABEL[l]).toBeTruthy();
			expect(LEVEL_APPROVER[l]).toBeTruthy();
		}
	});
	it('tous les statuts, types, événements et sévérités de finding ont un libellé', () => {
		for (const s of FINDING_STATUSES) expect(FINDING_STATUS_LABEL[s]).toBeTruthy();
		for (const t of FINDING_TYPES) expect(FINDING_TYPE_LABEL[t]).toBeTruthy();
		for (const e of FINDING_EVENT_TYPES) expect(FINDING_EVENT_LABEL[e]).toBeTruthy();
		for (const s of FINDING_SEVERITIES) expect(SEVERITY_LABEL[s]).toBeTruthy();
	});
	it('L4 dit explicitement « une par une » — c’est la règle du lot', () => {
		expect(LEVEL_APPROVER.L4).toContain('une par une');
	});
	it('un risque absent se lit « inconnu », jamais « faible »', () => {
		expect(RISK_LABEL.inconnu).toBe('inconnu');
	});
});

describe('shortHash', () => {
	it('tronque et marque la troncature', () => {
		expect(shortHash('0123456789abcdef0123')).toBe('0123456789ab…');
	});
	it('ne tronque pas ce qui est déjà court', () => {
		expect(shortHash('abc')).toBe('abc');
	});
	it('absent → tiret (jamais « undefined »)', () => {
		expect(shortHash(null)).toBe('—');
		expect(shortHash(undefined)).toBe('—');
	});
});

describe('priorityBand (le seuil 60 est celui du producteur, pas une couleur)', () => {
	it('60 est la frontière du proposable', () => {
		expect(priorityBand(59)).toBe('basse');
		expect(priorityBand(60)).toBe('moyenne');
	});
	it('80 et plus : haute', () => {
		expect(priorityBand(80)).toBe('haute');
		expect(priorityBand(100)).toBe('haute');
	});
});

describe('prettyJson', () => {
	it('indente un JSON valide', () => {
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
	});
	it('rend une valeur illisible TELLE QUELLE (une donnée corrompue n’est pas une absence)', () => {
		expect(prettyJson('{oops')).toBe('{oops');
	});
	it('absent → null', () => {
		expect(prettyJson(null)).toBeNull();
		expect(prettyJson('')).toBeNull();
	});
});
