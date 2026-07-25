-- IDX-004 — Registre des décisions de sélection d'inspection. Phase expand, additif, idempotent.
-- Miroir fidèle de `indexSelection` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-idx-004.ts. Aucune donnée touchée, aucun DROP.
--
-- Pourquoi une table et pas une dérivation :
--   deux des trois acceptations IDX-004 sont indérivables. « Chaque sélection expose sa
--   raison » : la raison est fonction de l'état AU MOMENT du choix (diff sitemap, findings
--   actifs, clics 28 j) — rejouer la politique une semaine plus tard rend une autre raison,
--   et « nouvelle page » n'est vrai qu'une fois. « Une inspection manquée est replanifiée
--   sans duplication » : « manquée » veut dire SÉLECTIONNÉE mais non observée ; sans trace
--   de l'intention, une URL dont le quota a été payé sans rien produire (429 au 3ᵉ appel,
--   bail perdu, réponse illisible) est totalement invisible. Ce serait exactement « une
--   absence de mesure prise pour une preuve », que tout ce canon existe pour empêcher.
--
-- ⚠️ CETTE TABLE EST OPTIMISTE : une ligne est une INTENTION, jamais une preuve d'inspection.
--    Elle est écrite AVANT que Google réponde (délibérément : sinon un 429 au 3ᵉ appel ferait
--    perdre les 37 intentions suivantes, et rien ne serait replanifié). Tout comptage de FAIT
--    passe donc obligatoirement par la jointure :
--        honorée ⇔ ∃ index_observations(project_id, url = url_normalized, observed_date >= due_date)
--    Lire cette table seule pour compter « pages inspectées » compterait des intentions.
--
-- Pourquoi AUCUNE colonne de statut :
--   un `status` pending/done/failed serait un second état persistant dont personne n'est
--   propriétaire du retour — même motif que le `health_status = 'quota_limited'` rejeté par
--   JOB-006. Le résultat se DÉRIVE de `index_observations`, qui est le fait.
--
-- ⚠️ L'unique porte `url_normalized` ET `due_date` : c'est l'anti-duplication littérale de
--    l'acceptation 3. `url_normalized` est aussi la chaîne effectivement envoyée à Google —
--    sans elle, `…/page` et `…/page#a` paieraient deux slots pour une seule page et
--    produiraient deux séries trop courtes pour que `confirmTransition` (IDX-005) conclue
--    jamais quoi que ce soit. `url` garde la forme source (trace).
--
-- Le grain est le JOUR, comme `index_observations.observed_date` et
-- `sitemap_url_observations.observed_date`. Une seconde granularité rendrait la jointure
-- « honorée » inexacte. C'est aussi ce qui porte J+3/J+7/J+28 : une ligne posée avec
-- `due_date = publication + 28 j` EST le rappel J+28 — sans job, sans horloge, sans worker.
--
-- La table naît VIDE : appliquer ce DDL ne change aucun comportement.
-- Écart d'introspection ATTENDU : 58 → 59 tables `seostats`, et exactement celle-ci.

CREATE TABLE IF NOT EXISTS "seostats"."index_selection" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"schema_version" integer NOT NULL DEFAULT 1,
	"due_date" text NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"reason" text NOT NULL,
	"reason_detail" text,
	"bucket" text NOT NULL DEFAULT 'priority',
	"rank" integer NOT NULL DEFAULT 0,
	"selector_version" text NOT NULL,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "index_selection_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "index_selection_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);

-- ACCEPTATION 3, littéralement : replanifier une échéance déjà posée ne crée pas de ligne.
CREATE UNIQUE INDEX IF NOT EXISTS "index_selection_unique"
	ON "seostats"."index_selection" ("project_id", "url_normalized", "due_date");

-- « Que dois-je inspecter aujourd'hui » : la lecture chaude, à chaque passe.
CREATE INDEX IF NOT EXISTS "idx_index_selection_project_due"
	ON "seostats"."index_selection" ("project_id", "due_date");

-- « Pourquoi cette page a-t-elle coûté du quota, et quand » : l'audit d'une URL.
CREATE INDEX IF NOT EXISTS "idx_index_selection_project_url"
	ON "seostats"."index_selection" ("project_id", "url_normalized");
