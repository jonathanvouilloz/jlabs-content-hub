/**
 * Projection canonique des reponses d'avis Barber Concept.
 *
 * Source metier :
 * - projets/barberconcept/docs/business/profile.md (valide le 2026-09-02)
 * - projets/barberconcept/docs/identity.md
 * - projets/barberconcept/docs/channels/gmb.md
 *
 * Dry-run par defaut. `--apply` promeut uniquement la projection ; ce script ne cree ni ne
 * modifie aucune policy et ne peut donc pas autoriser une publication Google.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { and, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { assertNoInlineSecret } from '../src/lib/server/projection-state.js';
import { parseReviewReplyContext } from '../src/lib/server/reviews/review-reply-context-state.js';

neonConfig.webSocketConstructor = ws;

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const LOCATION = {
	cornavin: 'locations/776717144794334207',
	eauxVives: 'locations/8068834285998034178',
	jonction: 'locations/12743724963296165280',
	rive: 'locations/6692186161413459468',
	lausanne: 'locations/4735391311439608561',
	sion: 'locations/9613432581015768943'
} as const;

type LocationKey = keyof typeof LOCATION;

const roster: Array<{
	id: string;
	displayName: string;
	aliases?: string[];
	locations: LocationKey[];
	active?: boolean;
	publicReplyAllowed?: boolean;
}> = [
	{ id: 'henok-josief', displayName: 'Henok Josief', locations: [] },
	{ id: 'moha', displayName: 'Moha', locations: ['lausanne'] },
	{ id: 'moss', displayName: 'Moss', locations: ['eauxVives'] },
	{ id: 'alexis', displayName: 'Alexis', locations: ['sion'] },
	{ id: 'raphael', displayName: 'Raphaël', aliases: ['Rapahael'], locations: ['lausanne'] },
	{ id: 'brandon', displayName: 'Brandon', locations: ['cornavin'] },
	{ id: 'noe', displayName: 'Noé', locations: ['rive'] },
	{ id: 'felipe', displayName: 'Felipe', locations: ['cornavin'] },
	{ id: 'enzo', displayName: 'Enzo', locations: ['cornavin'] },
	{ id: 'oums', displayName: 'Oums', aliases: ['Oumss'], locations: ['rive'] },
	{ id: 'ouss', displayName: 'Ouss', locations: ['rive'] },
	{ id: 'wesley', displayName: 'Wesley', locations: ['lausanne'] },
	{ id: 'imrane', displayName: 'Imrane', aliases: ['Imran'], locations: ['rive'] },
	{ id: 'muguy', displayName: 'Muguy', aliases: ['Mugy'], locations: ['eauxVives'] },
	{ id: 'mohammed', displayName: 'Mohammed', locations: ['jonction'] },
	{ id: 'jessy', displayName: 'Jessy', locations: ['rive'] },
	{ id: 'ilias', displayName: 'Ilias', locations: ['rive'] },
	{ id: 'jasko', displayName: 'Jasko', locations: ['eauxVives'] },
	{ id: 'issam', displayName: 'Issam', locations: ['eauxVives'] },
	{ id: 'emanuel', displayName: 'Emanuel', locations: ['sion'] },
	{ id: 'mohcen', displayName: 'Mohcen', locations: ['sion'] },
	{ id: 'santos', displayName: 'Santos', locations: ['sion'] },
	{ id: 'thomas', displayName: 'Thomas', locations: ['rive'] },
	{ id: 'hk', displayName: 'HK', locations: ['jonction'] },
	{ id: 'giuseppe', displayName: 'Giuseppe', locations: ['lausanne'] },
	{
		id: 'kavind',
		displayName: 'Kavind',
		locations: ['sion'],
		active: false,
		publicReplyAllowed: false
	},
	{
		id: 'anderson',
		displayName: 'Anderson',
		locations: ['rive'],
		active: false,
		publicReplyAllowed: false
	}
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

try {
	const project = await db.query.projects.findFirst({
		where: eq(schema.projects.slug, 'barberconcept')
	});
	if (!project) throw new Error('barberconcept project not found');

	const locations = await db
		.select({ id: schema.projectGmbLocations.gmbLocationId, label: schema.projectGmbLocations.label })
		.from(schema.projectGmbLocations)
		.where(eq(schema.projectGmbLocations.projectId, project.id));
	const labels = new Map(locations.map((location) => [location.id, location.label]));
	const expectedIds = Object.values(LOCATION).sort();
	const actualIds = locations.map((location) => location.id).sort();
	if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
		throw new Error(`location mapping drift: expected ${expectedIds.length}, found ${actualIds.length}`);
	}

	const payload = {
		gmb: {
			reviewReplies: {
				version: '2026-09-24.1',
				businessName: 'Barber Concept',
				defaultSignature: "L'équipe Barber Concept",
				contactEmail: 'contact@barberconcept.ch',
				locations: expectedIds.map((id) => ({ id, label: labels.get(id) })),
				voice: {
					tutoiement: true,
					banned: [
						'atelier',
						'solutions',
						'innovant',
						'dans un monde où',
						'synergies',
						'expertise reconnue',
						'game-changer',
						'disruptif',
						'écosystème',
						'transformation digitale'
					]
				},
				interdits: [
					'Ne jamais citer un prix de mémoire.',
					'Ne jamais nommer une personne absente du roster public de la fiche.',
					'Ne jamais automatiser une réponse à un avis 1 à 3 étoiles.',
					'Ne jamais répondre automatiquement à une accusation ou un contenu sensible.'
				]
			},
			employeeMentions: {
				enabled: true,
				version: '2026-09-02.1',
				employees: roster.map((employee) => ({
					id: employee.id,
					displayName: employee.displayName,
					aliases: employee.aliases ?? [],
					locations: employee.locations.map((key) => LOCATION[key]),
					active: employee.active ?? true,
					eligibleForBonus: false,
					publicReplyAllowed: employee.publicReplyAllowed ?? true
				}))
			}
		}
	};

	for (const id of expectedIds) {
		const parsed = parseReviewReplyContext(payload, id);
		if (!parsed.ok) throw new Error(`projection invalid for ${id}: ${parsed.reason}`);
	}

	const serialized = JSON.stringify(payload);
	assertNoInlineSecret(serialized, 'barberconcept review projection');
	const sourceHash = createHash('sha256').update(serialized).digest('hex');
	const current = await db.query.projectProjections.findFirst({
		where: and(
			eq(schema.projectProjections.projectId, project.id),
			eq(schema.projectProjections.status, 'current')
		)
	});

	const summary = {
		mode: apply ? 'apply' : 'dry-run',
		project: project.slug,
		sourceHash,
		duplicate: current?.sourceHash === sourceHash,
		locations: expectedIds.length,
		activeEmployees: roster.filter((employee) => employee.active !== false).length,
		publicEmployees: roster.filter((employee) => employee.publicReplyAllowed !== false).length
	};

	if (!apply || current?.sourceHash === sourceHash) {
		console.log(JSON.stringify(summary, null, 2));
	} else {
		const now = toDbTimestamp();
		await db.transaction(async (tx) => {
			if (current) {
				await tx
					.update(schema.projectProjections)
					.set({ status: 'stale' })
					.where(eq(schema.projectProjections.id, current.id));
			}
			await tx.insert(schema.projectProjections).values({
				id: createId(),
				projectId: project.id,
				schemaVersion: 1,
				sourceHash,
				payload: serialized,
				status: 'current',
				validationErrors: null,
				compiledAt: now,
				receivedAt: now
			});
		});
		console.log(JSON.stringify({ ...summary, promoted: true }, null, 2));
	}
} finally {
	await pool.end();
}
