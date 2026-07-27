import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import {
	findPreviousSlot,
	listReportRevisions,
	loadPublishedReport
} from '$lib/server/report-publication.js';
import { buildReportView } from '$lib/server/report-read-state.js';
import {
	compareReports,
	describeLineage,
	sectionHasChange
} from '$lib/server/report-history-state.js';
import type { PageServerLoad } from './$types.js';

/**
 * DASH-003 lot 2 ch.3 + REP-004 lot 1 — `/reports/[slot]` : UN rapport publié, tel qu'il a été
 * publié, avec son lignage et ce qui a changé depuis le point de référence.
 *
 * ⭐ **Rien n'est reconstruit.** Le JSON rendu est exactement `payload_json` — aucun appel
 * provider, aucune requête d'agrégat, aucune dépendance à l'état courant de la base. C'est
 * l'acceptation REP-003 « il reste accessible après restart ». Et c'est ce qui rend la
 * comparaison honnête : les DEUX côtés sont des archives, pas un archivé contre un recalculé.
 *
 * ⚠️ **404 sur un créneau inconnu, jamais une page vide.** « Pas encore publié » et « n'existe
 * pas » demandent deux gestes différents ; une page vide les confondrait.
 *
 * ⚠️ **Un payload illisible LÈVE** (`loadPublishedReport`) : un rapport archivé qu'on ne sait
 * plus relire est une anomalie à voir tout de suite, pas un `null` à interpréter comme « pas
 * encore publié ». On ne l'attrape donc pas ici.
 *
 * ⚠️ **La comparaison charge un SECOND payload** (~28 kio) : elle vit sur le détail, jamais sur
 * la liste. `?compare=none` la coupe pour qui veut la page nue.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	// SvelteKit décode déjà `params.slot` : la valeur reçue est le `period_slot` exact, `:` compris.
	const periodSlot = params.slot;

	// `?revision=N` — l'ORIGINAL d'un créneau révisé doit rester atteignable, sinon « ne remplace
	// pas silencieusement » n'aurait pas de sujet. Un numéro illisible est ignoré (on rend la
	// révision courante) plutôt que 404 : c'est un paramètre d'URL, pas une ressource.
	const rawRevision = Number(url.searchParams.get('revision'));
	const revision = Number.isInteger(rawRevision) && rawRevision > 0 ? rawRevision : undefined;

	const published = await loadPublishedReport({ db, periodSlot, revision });
	if (!published) {
		throw error(
			404,
			revision === undefined
				? `Aucun rapport publié pour le créneau ${periodSlot}`
				: `Le créneau ${periodSlot} n’a pas de révision ${revision}`
		);
	}

	const revisions =
		published.revisionCount > 1 ? await listReportRevisions({ db, periodSlot }) : [];
	const lineage =
		revisions.length > 1
			? describeLineage(
					revisions.map((r) => ({
						id: r.id,
						revision: r.revision,
						status: r.status,
						publishedAt: r.publishedAt,
						revisionReason: r.revisionReason
					}))
				)
			: null;

	const view = buildReportView({
		periodSlot: published.periodSlot,
		status: published.status,
		publishedAt: published.publishedAt,
		reportSchemaVersion: published.reportSchemaVersion,
		// Le SLO vient de `toMeta` (`deriveSlo`), unique autorité sur le verdict — et il porte
		// sur la PREMIÈRE publication du créneau, pas sur la révision affichée.
		slo: published.slo,
		readiness: published.readiness,
		report: published.report,
		revision: published.revision,
		revisionCount: published.revisionCount,
		revisionReason: published.revisionReason,
		lineage
	});

	// ── Le point de référence ────────────────────────────────────────
	//
	// Par défaut : la révision précédente s'il y en a une (« qu'est-ce que la régénération a
	// changé ? »), sinon le créneau publié juste avant (« qu'est-ce qui a changé depuis la
	// semaine dernière ? »). L'ordre n'est pas arbitraire : quand un créneau vient d'être
	// révisé, la question qu'on se pose en l'ouvrant est celle de la révision.
	const compareParam = url.searchParams.get('compare');
	let basePoint: { periodSlot: string; revision: number } | null = null;
	if (compareParam === 'none') {
		basePoint = null;
	} else if (compareParam === 'previous_slot' || published.revision === 1) {
		basePoint = await findPreviousSlot({ db, periodSlot });
	} else {
		basePoint = { periodSlot, revision: published.revision - 1 };
	}

	const baseReport = basePoint
		? await loadPublishedReport({ db, periodSlot: basePoint.periodSlot, revision: basePoint.revision })
		: null;

	const comparison = baseReport
		? compareReports({
				base: {
					periodSlot: baseReport.periodSlot,
					revision: baseReport.revision,
					reportSchemaVersion: baseReport.reportSchemaVersion,
					report: baseReport.report
				},
				head: {
					periodSlot: published.periodSlot,
					revision: published.revision,
					reportSchemaVersion: published.reportSchemaVersion,
					report: published.report
				}
			})
		: null;

	// ⚠️ Le filtre vit dans le module PUR (`sectionHasChange`), appliqué ici : un `{#if}` de
	// template déciderait de ce qui est montré sans être testable, et une section muette
	// disparaîtrait sans que rien n'échoue. Le nombre d'écartées est TOUJOURS dit (doctrine
	// `buildTimeline` : une liste filtrée qui tait sa coupe se lit comme une liste complète).
	const sections = comparison?.kind === 'available' ? comparison.sections : [];
	const changedSections = sections.filter(sectionHasChange);

	return {
		view,
		comparison,
		changedSections,
		unchangedSections: sections.length - changedSections.length,
		/**
		 * ⚠️ « Pas de comparaison » est un ÉTAT, pas un `null` muet : le premier rapport du parc
		 * n'a rien avant lui, ce qui n'est pas la même chose qu'une semaine sans changement.
		 */
		comparisonAbsence: comparison
			? null
			: compareParam === 'none'
				? 'Comparaison désactivée (`?compare=none`).'
				: 'Aucun rapport antérieur à comparer : c’est le premier créneau publié. Ce n’est pas « rien n’a changé ».',
		baseHref: baseReport
			? `/reports/${encodeURIComponent(baseReport.periodSlot)}${
					baseReport.revision > 1 ? `?revision=${baseReport.revision}` : ''
				}`
			: null
	};
};
