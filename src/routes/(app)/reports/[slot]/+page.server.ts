import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { loadPublishedReport } from '$lib/server/report-publication.js';
import { buildReportView } from '$lib/server/report-read-state.js';
import type { PageServerLoad } from './$types.js';

/**
 * DASH-003 lot 2 chantier 3 — `/reports/[slot]` : UN rapport publié, tel qu'il a été publié.
 *
 * ⭐ **Rien n'est reconstruit.** Le JSON rendu est exactement `payload_json` — aucun appel
 * provider, aucune requête d'agrégat, aucune dépendance à l'état courant de la base. C'est
 * l'acceptation REP-003 « il reste accessible après restart », et c'est aussi ce qui rend
 * REP-004 possible : deux lectures à trois semaines d'écart doivent rendre le même rapport.
 * Recalculer une seule section ferait dire à l'écran de lundi prochain autre chose que ce qui
 * a été publié lundi dernier.
 *
 * ⚠️ **404 sur un créneau inconnu, jamais une page vide.** « Pas encore publié » et « n'existe
 * pas » demandent deux gestes différents ; une page vide les confondrait.
 *
 * ⚠️ **Un payload illisible LÈVE** (`loadPublishedReport`) : un rapport archivé qu'on ne sait
 * plus relire est une anomalie à voir tout de suite, pas un `null` à interpréter comme « pas
 * encore publié ». On ne l'attrape donc pas ici.
 */
export const load: PageServerLoad = async ({ params }) => {
	// SvelteKit décode déjà `params.slot` : la valeur reçue est le `period_slot` exact, `:` compris.
	const published = await loadPublishedReport({ db, periodSlot: params.slot });
	if (!published) throw error(404, `Aucun rapport publié pour le créneau ${params.slot}`);

	return {
		view: buildReportView({
			periodSlot: published.periodSlot,
			status: published.status,
			publishedAt: published.publishedAt,
			reportSchemaVersion: published.reportSchemaVersion,
			// Le SLO vient de `toMeta` (`deriveSlo`), unique autorité sur le verdict.
			slo: published.slo,
			readiness: published.readiness,
			report: published.report
		})
	};
};
