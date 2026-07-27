-- REP-003 — Le rapport du lundi, publié. Phase expand, additif, idempotent.
-- Miroir fidèle de `weeklyReports` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-rep-003.ts. Aucune donnée touchée, aucun DROP.
--
-- Pourquoi une table et pas une dérivation :
--   « il reste accessible après restart » ne se dérive de RIEN. Sur Vercel aucun processus ne
--   survit à la requête, et reconstruire le rapport une heure plus tard ne rend pas le même
--   objet : les findings ont bougé, la santé a changé. Le rapport publié est un FAIT daté, pas
--   une vue. C'est aussi la seule façon de mesurer le SLO §17.3 : sans `published_at` écrit,
--   « terminé avant 10:00 » n'est vérifiable par personne.
--
-- ⚠️ AUCUN `project_id`. Première table du schéma dans ce cas, délibérément : le rapport
--    hebdo est CROSS-PROJET (un objet couvre les 9 projets). Un `project_id` aurait imposé
--    9 lignes portant 9 fois le même JSON, et « un seul rapport logique existe par semaine »
--    serait redevenu une convention au lieu d'une contrainte.
--
-- ⚠️ `period_slot` est un CRÉNEAU LOCAL (`2026-07-27T09:00`, Europe/Zurich), jamais un
--    instant. Même clé logique que `monitoring_runs.period_end` et les clés d'idempotence de
--    JOB-005, et pour la même raison : le lundi 09:00 métier est stable des deux côtés du
--    changement d'heure, alors que son instant UTC ne l'est pas (07:00 l'été, 08:00 l'hiver).
--
-- ⚠️ AUCUN statut de SLO en colonne. `published_at <= due_at` se DÉRIVE à la lecture — même
--    discipline qu'« honorée » (IDX-004) et que l'expiration d'un snooze (FIND-003). Un
--    booléen persisté serait un second état à tenir, qui mentirait dès que l'échéance change.
--
-- ⚠️ JAMAIS d'UPDATE sur cette table. Republier un créneau déjà publié est un NO-OP
--    (`ON CONFLICT DO NOTHING`), jamais un écrasement : c'est la graine de REP-004
--    (« régénérer un rapport ne remplace pas silencieusement l'original »). Conséquence
--    assumée : un rapport publié `partial` à l'échéance ne devient jamais `complete`, même si
--    la collecte se termine à 10:30. La révision est un lot à part, et elle AJOUTERA des
--    lignes.
--
-- La table naît VIDE : appliquer ce DDL ne change aucun comportement (aucun rapport publié,
-- donc `loadPublishedReport` rend `null` et le tick publiera au prochain créneau).
-- Écart d'introspection ATTENDU : 60 → 61 tables `seostats`, et exactement celle-ci.

CREATE TABLE IF NOT EXISTS "seostats"."weekly_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"period_slot" text NOT NULL,
	"status" text NOT NULL,
	"schema_version" integer NOT NULL DEFAULT 1,
	"report_schema_version" integer NOT NULL,
	"slot_at" text NOT NULL,
	"due_at" text NOT NULL,
	"published_at" text NOT NULL,
	"readiness_json" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- ACCEPTATION 1, littéralement : « un seul rapport logique existe par semaine ».
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_reports_period_unique"
	ON "seostats"."weekly_reports" ("period_slot");

-- « Les derniers rapports publiés » : la lecture de REP-004 et de l'onglet Rapports.
CREATE INDEX IF NOT EXISTS "idx_weekly_reports_published"
	ON "seostats"."weekly_reports" ("published_at");
