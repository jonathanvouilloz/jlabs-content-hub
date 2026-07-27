-- REP-004 lot 1 — La révision d'un rapport publié. Phase expand + contract, idempotent.
-- Miroir fidèle de `weeklyReports` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-rep-004.ts. AUCUNE nouvelle table (61), aucune donnée touchée.
--
-- Ce que REP-003 avait laissé écrit dans son propre DDL :
--   « JAMAIS d'UPDATE sur cette table. Republier un créneau déjà publié est un NO-OP […]
--     Conséquence assumée : un rapport publié `partial` à l'échéance ne devient jamais
--     `complete`, même si la collecte se termine à 10:30. La révision est un lot à part, et
--     elle AJOUTERA des lignes. »
--   C'est ce lot. Et « elle ajoutera des lignes » est le DDL entier : la révision est une
--   INSERTION, jamais une réécriture. L'acceptation « régénérer un rapport ne remplace pas
--   silencieusement l'original » cesse d'être une convention le jour où l'original ne peut
--   PLUS être écrasé — parce qu'il porte sa propre ligne, et que l'unique protège le couple.
--
-- ⚠️ L'UNIQUE CHANGE DE SUJET, et c'est le seul geste non additif du fichier.
--    Avant : (period_slot) — « un seul rapport par créneau ».
--    Après : (period_slot, revision) — « un seul rapport par créneau ET PAR RÉVISION ».
--    L'acceptation REP-003 (« un seul rapport logique existe par semaine ») n'est pas perdue,
--    elle est déplacée dans le CODE : `publishWeeklyReport` — le chemin AUTOMATIQUE, celui du
--    tick — n'écrit jamais que `revision = 1`, et son `ON CONFLICT DO NOTHING` porte
--    désormais sur le couple. Un cron qui repasse cent fois sur le même lundi produit donc
--    toujours exactement une ligne. Une révision >= 2 n'existe que par un geste DÉLIBÉRÉ
--    (`reviseWeeklyReport`), jamais par une horloge : sans cette asymétrie, un tick instable
--    réécrirait la semaine indéfiniment et l'historique deviendrait du bruit.
--
--    L'ordre des deux instructions n'est pas indifférent : le nouvel unique est créé AVANT
--    que l'ancien tombe. À aucun instant la table n'est sans protection contre le doublon.
--
-- ⚠️ `revision_reason` est OBLIGATOIRE dès la deuxième révision, et c'est une CONTRAINTE, pas
--    une politesse de la couche métier. « Ne remplace pas silencieusement » se prouve mal avec
--    une colonne qu'on peut laisser vide : une révision sans raison est un remplacement
--    silencieux qui a simplement gardé l'ancienne ligne. Le CHECK rend le silence impossible.
--
-- ⚠️ `supersedes_id` n'a délibérément PAS de clé étrangère vers `weekly_reports(id)`. C'est un
--    pointeur d'HISTOIRE : il doit survivre à la rétention (lot 2), qui pourra vider le détail
--    d'un vieux rapport. Une FK ferait de la rétention un choix entre casser le lignage
--    (CASCADE) et ne plus rien pouvoir purger (RESTRICT).
--
-- Écart d'introspection ATTENDU : 61 → 61 tables `seostats` (aucune table créée), et sur
-- `weekly_reports` : 11 → 14 colonnes, index `weekly_reports_period_unique` remplacé par
-- `weekly_reports_period_revision_unique`.

-- 1. Les trois colonnes de l'histoire. Additives, avec défaut : les rapports déjà publiés
--    (s'il y en a) deviennent tous « révision 1 », ce qu'ils sont.
ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "revision_reason" text;

ALTER TABLE "seostats"."weekly_reports"
	ADD COLUMN IF NOT EXISTS "supersedes_id" text;

-- 2. Le nouvel unique AVANT l'ancien DROP (jamais de fenêtre sans protection).
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_reports_period_revision_unique"
	ON "seostats"."weekly_reports" ("period_slot", "revision");

-- 3. L'ancien unique tombe : il interdisait littéralement la deuxième révision.
DROP INDEX IF EXISTS "seostats"."weekly_reports_period_unique";

-- 4. Une révision porte toujours sa raison. Postgres n'a pas d'ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		 WHERE conname = 'weekly_reports_revision_reason_check'
		   AND conrelid = '"seostats"."weekly_reports"'::regclass
	) THEN
		ALTER TABLE "seostats"."weekly_reports"
			ADD CONSTRAINT "weekly_reports_revision_reason_check"
			CHECK ("revision" = 1 OR "revision_reason" IS NOT NULL);
	END IF;
END
$$;

-- Aucun index de lecture ajouté : « l'histoire d'un créneau » (`/reports/[slot]`) se lit par
-- `period_slot` en préfixe de l'unique (period_slot, revision), qui la sert déjà. Un second
-- index sur les mêmes colonnes ne serait qu'un coût d'écriture.
