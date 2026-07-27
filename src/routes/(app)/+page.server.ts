import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects } from '$lib/server/db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { loadHomeCockpit } from '$lib/server/home.js';
import { normalizeWindowDays } from '$lib/server/home-state.js';
import { listPublishedReports } from '$lib/server/report-publication.js';
import { summarizeReportList } from '$lib/server/report-read-state.js';

/**
 * DASH-002 — L'accueil EST le cockpit cross-projet (SPEC §13.1).
 *
 * Ce que la page doit permettre : « identifier en moins d'une minute les projets
 * nécessitant une action ». D'où l'ordre à l'écran — les projets à traiter d'abord, triés
 * par urgence, chacun avec UNE phrase qui nomme l'axe en cause (collecte cassée vs
 * performance en baisse, jamais un score unique qui les confondrait).
 *
 * Tout le jugement vit dans `home-state.ts` (pur, testé) et toute la lecture dans
 * `home.ts` (client injecté) : ce loader ne fait que passer la fenêtre et rendre. Un
 * calcul posé ici serait invisible aux tests et au runner de preuve.
 *
 * Le bandeau CONTENU (compteurs + derniers contenus) reste, en second : c'est l'ancien
 * accueil Content Hub, il sert encore, mais il ne décide de rien — il passe donc sous ce
 * qui décide. Aucune route n'est supprimée.
 */
export const load: PageServerLoad = async ({ url }) => {
	const windowDays = normalizeWindowDays(url.searchParams.get('days'));

	const [cockpit, lastReports, statusCounts, recentContents] = await Promise.all([
		loadHomeCockpit({ db, windowDays }),
		// DASH-003 lot 2 ch.3 — « accès au rapport consolidé » (SPEC §13.1).
		//
		// ⚠️ La méta passe par `listPublishedReports`, PAS par un compteur ajouté à
		// `home-state.ts` : le SLO et le statut n'ont qu'une autorité (`toMeta` → `deriveSlo`),
		// et un second calcul ici afficherait « SLO tenu » sur l'accueil au-dessus d'un
		// « SLO manqué » sur `/reports`. Un seul créneau : l'accueil pointe, il ne liste pas.
		listPublishedReports({ db, limit: 1 }),
		db
			.select({
				draft: sql<number>`sum(case when ${contents.status} = 'draft' then 1 else 0 end)`,
				review: sql<number>`sum(case when ${contents.status} = 'review' then 1 else 0 end)`,
				approved: sql<number>`sum(case when ${contents.status} = 'approved' then 1 else 0 end)`,
				published: sql<number>`sum(case when ${contents.status} = 'published' then 1 else 0 end)`,
				total: sql<number>`count(*)`
			})
			.from(contents)
			.then((r) => r[0]),
		db
			.select({
				id: contents.id,
				title: contents.title,
				type: contents.type,
				status: contents.status,
				plannedDate: contents.plannedDate,
				createdAt: contents.createdAt,
				projectId: contents.projectId,
				projectName: projects.name,
				projectColor: projects.color,
				projectSlug: projects.slug
			})
			.from(contents)
			.leftJoin(projects, eq(contents.projectId, projects.id))
			.orderBy(desc(contents.createdAt))
			.limit(8)
	]);

	return {
		cockpit,
		/** Le dernier rapport publié, ou `null` — **jamais** un rapport fabriqué pour l'occasion. */
		lastReport: summarizeReportList(lastReports)[0] ?? null,
		contentStats: {
			draft: statusCounts?.draft ?? 0,
			review: statusCounts?.review ?? 0,
			approved: statusCounts?.approved ?? 0,
			published: statusCounts?.published ?? 0,
			total: statusCounts?.total ?? 0
		},
		recentContents
	};
};
