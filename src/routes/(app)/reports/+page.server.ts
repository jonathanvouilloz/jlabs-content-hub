import { db } from '$lib/server/db/index.js';
import { listPublishedReports } from '$lib/server/report-publication.js';
import { describeReportsFreshness, summarizeReportList } from '$lib/server/report-read-state.js';
import { dbTimestampToMs } from '$lib/server/timestamps.js';
import type { PageServerLoad } from './$types.js';

/**
 * DASH-003 lot 2 chantier 3 — `/reports` : la liste des rapports hebdomadaires PUBLIÉS.
 *
 * ⭐ **L'écran est cross-projet parce que la table l'est.** `weekly_reports` n'a pas de
 * `project_id` (décision REP-003 : le rapport est cross-projet, et 9 jobs auraient écrit le
 * même rapport). Un onglet sous `/projects/[slug]` ne pourrait afficher ni le résumé exécutif,
 * ni un seul chiffre — les `metrics` sont des `count(*)` de parc — sans mentir sur leur portée.
 * L'écran vit donc là où la donnée vit, et SPEC §13.1 le prévoit (« accès au rapport consolidé »).
 *
 * ⚠️ **Aucun payload n'est chargé ici.** `listPublishedReports` ne sélectionne pas `payload_json`
 * (plusieurs dizaines de kilo-octets par rapport) : la liste paierait douze rapports complets
 * pour afficher douze dates. Le payload se lit à l'unité, dans `[slot]`.
 *
 * Le loader ne fait que passer : tout le jugement vit dans `report-read-state.ts` (pur, testé),
 * toute la lecture dans `report-publication.ts` — dont `toMeta` est la SEULE autorité sur le SLO.
 */
export const load: PageServerLoad = async () => {
	const metas = await listPublishedReports({ db, limit: 12 });
	return {
		rows: summarizeReportList(metas),
		freshness: describeReportsFreshness({
			// ⚠️ L'âge se compte sur `slot_at` (instant UTC), le libellé sur `period_slot`
			// (créneau local) : les confondre décalerait la mesure d'une à deux heures selon
			// la saison, ou afficherait 07:00 pour le lundi 09:00 de Jonathan.
			entries: metas.map((m) => ({ periodSlot: m.periodSlot, slotAt: m.slotAt })),
			nowMs: Date.now(),
			parseMs: dbTimestampToMs
		})
	};
};
