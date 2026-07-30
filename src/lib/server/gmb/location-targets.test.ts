import { describe, it, expect } from 'vitest';
import {
	normalizeLocationTarget,
	readLocationTargets,
	resolveLocationTargets,
	describeUnresolvedTarget
} from './location-targets.js';

const LOCATIONS = [
	{ gmbLocationId: 'locations/776717144794334207', label: 'Cornavin' },
	{ gmbLocationId: 'locations/9613432581015768943', label: 'Sion' },
	{ gmbLocationId: 'locations/4735391311439608561', label: 'Lausanne' }
];

describe('normalizeLocationTarget', () => {
	it('rend équivalentes les formes préfixée et nue du même identifiant', () => {
		expect(normalizeLocationTarget('locations/123')).toBe(normalizeLocationTarget('123'));
	});

	it('ne confond pas deux identifiants différents', () => {
		expect(normalizeLocationTarget('locations/123')).not.toBe(normalizeLocationTarget('124'));
	});
});

describe('readLocationTargets', () => {
	it('lit la forme canonique produite par les skills', () => {
		expect(readLocationTargets({ target_location: 'locations/123' })).toEqual(['locations/123']);
	});

	it('lit encore la forme tableau historique', () => {
		expect(readLocationTargets({ target_locations: ['locations/123'] })).toEqual(['locations/123']);
	});

	it('traite "all" comme une absence de ciblage', () => {
		expect(readLocationTargets({ target_location: 'all' })).toEqual([]);
	});

	it('résout une contradiction vers le plus large', () => {
		// Cibler « tout » ET une fiche ne peut pas vouloir dire « seulement cette fiche ».
		expect(readLocationTargets({ target_location: 'all', target_locations: ['locations/123'] })).toEqual([]);
	});

	it('ne voit aucune cible dans un meta absent, vide ou sans le champ', () => {
		expect(readLocationTargets(null)).toEqual([]);
		expect(readLocationTargets({})).toEqual([]);
		expect(readLocationTargets({ image_url: 'x' })).toEqual([]);
		expect(readLocationTargets({ target_location: '   ' })).toEqual([]);
	});
});

describe('resolveLocationTargets', () => {
	it('sans cible, vise toutes les fiches du projet', () => {
		const r = resolveLocationTargets(LOCATIONS, { position: 1 });
		expect(r.kind).toBe('all');
		expect(r.kind === 'all' && r.locations).toHaveLength(3);
	});

	it('avec une cible connue, ne vise QUE cette fiche', () => {
		const r = resolveLocationTargets(LOCATIONS, { target_location: 'locations/9613432581015768943' });
		expect(r.kind).toBe('targeted');
		expect(r.kind === 'targeted' && r.locations.map((l) => l.label)).toEqual(['Sion']);
	});

	it('LA régression : un slug de repo ne se replie JAMAIS sur toutes les fiches', () => {
		// C'est exactement ce que /gmb-generate produisait, et ce qui a publié des posts de
		// Cornavin sur les six salons de barberconcept.
		const r = resolveLocationTargets(LOCATIONS, { target_location: 'locations/barber-sion' });
		expect(r.kind).toBe('unresolved');
		expect(r.kind === 'unresolved' && r.target).toBe('locations/barber-sion');
	});

	it('une cible inconnue reste unresolved même sans préfixe', () => {
		expect(resolveLocationTargets(LOCATIONS, { target_location: 'barber-sion' }).kind).toBe('unresolved');
	});

	it('distingue « aucune fiche déclarée » d’« une cible illisible »', () => {
		expect(resolveLocationTargets([], { target_location: 'locations/123' }).kind).toBe('no_locations');
		expect(resolveLocationTargets([], null).kind).toBe('no_locations');
	});

	it('garde les fiches connues dans le refus, pour rendre le diagnostic possible', () => {
		const r = resolveLocationTargets(LOCATIONS, { target_location: 'locations/inconnu' });
		expect(r.kind === 'unresolved' && r.known).toHaveLength(3);
	});
});

describe('describeUnresolvedTarget', () => {
	it('nomme la cible reçue et les fiches connues', () => {
		const msg = describeUnresolvedTarget('locations/barber-sion', ['locations/123']);
		expect(msg).toContain('locations/barber-sion');
		expect(msg).toContain('locations/123');
	});
});
