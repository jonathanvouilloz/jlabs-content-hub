-- Retrait de GMB et LinkedIn — phase contract (DROP).
-- Date : 2026-10-24
-- Contexte : GMB et LinkedIn coupés le 2026-10-19 (62dfe48), code retiré dans le même
-- commit que ce fichier. Données d'origine archivées le 2026-10-19 :
-- noyau/backups/neon/seo-stats-gmb-linkedin-2026-10-19.json.enc.
--
-- ⚠️ DESTRUCTIF. Pré-requis : une branche Neon de sauvegarde créée juste avant
-- (le script d'application refuse de tourner sans `--backup-branch=<nom>`).
-- Appliqué par scripts/apply-drop-gmb-linkedin.ts, en UNE transaction : tout ou rien.
-- Pas de CASCADE : une dépendance inconnue fait échouer le DROP au lieu d'emporter
-- silencieusement autre chose.

BEGIN;

-- 1. Résidus GMB dans les tables partagées ─────────────────────────────

-- Jobs d'avis et de mentions (collecte, détecteurs) et leur historique d'exécution.
DELETE FROM "seostats"."job_attempts"
 WHERE "job_id" IN (SELECT "id" FROM "seostats"."jobs"
                     WHERE "type" IN ('collect:gmb_reviews', 'detect:review_pending', 'detect:employee_mentions'));
DELETE FROM "seostats"."job_effects"
 WHERE "job_id" IN (SELECT "id" FROM "seostats"."jobs"
                     WHERE "type" IN ('collect:gmb_reviews', 'detect:review_pending', 'detect:employee_mentions'));
DELETE FROM "seostats"."jobs"
 WHERE "type" IN ('collect:gmb_reviews', 'detect:review_pending', 'detect:employee_mentions');
DELETE FROM "seostats"."monitoring_steps"
 WHERE "step_type" IN ('collect:gmb_reviews', 'detect:review_pending', 'detect:employee_mentions');

-- Findings d'avis : plus aucun détecteur ne peut les résoudre, ils resteraient ouverts à vie.
DELETE FROM "seostats"."finding_events"
 WHERE "finding_id" IN (SELECT "id" FROM "seostats"."findings"
                         WHERE "type" IN ('review_pending_sla', 'negative_review', 'unknown_employee_mention'));
DELETE FROM "seostats"."findings"
 WHERE "type" IN ('review_pending_sla', 'negative_review', 'unknown_employee_mention');

-- 2. Tables GMB / LinkedIn (ordre = dépendances d'abord) ────────────────

DROP TABLE "seostats"."publish_logs";
DROP TABLE "seostats"."review_reply_delivery_events";
DROP TABLE "seostats"."review_reply_deliveries";
DROP TABLE "seostats"."review_reply_proposals";
DROP TABLE "seostats"."policy_promotions";
DROP TABLE "seostats"."review_automation_policies";
DROP TABLE "seostats"."review_mention_candidates";
DROP TABLE "seostats"."review_monthly_reports";
DROP TABLE "seostats"."employee_mentions";
DROP TABLE "seostats"."gmb_reviews";
DROP TABLE "seostats"."gmb_review_observations";
DROP TABLE "seostats"."gmb_insight_observations";
DROP TABLE "seostats"."gmb_insights_daily";
DROP TABLE "seostats"."gmb_location_profiles";
DROP TABLE "seostats"."gmb_profile_edits";
DROP TABLE "seostats"."gmb_ai_reports";
DROP TABLE "seostats"."project_gmb_locations";
DROP TABLE "seostats"."gmb_settings";
DROP TABLE "seostats"."linkedin_settings";

-- 3. Contenus GMB / LinkedIn (après publish_logs, qui les référençait) ────

DELETE FROM "seostats"."status_history"
 WHERE "content_id" IN (SELECT "id" FROM "seostats"."contents" WHERE "type" IN ('gmb', 'linkedin'));
DELETE FROM "seostats"."comments"
 WHERE "content_id" IN (SELECT "id" FROM "seostats"."contents" WHERE "type" IN ('gmb', 'linkedin'));
UPDATE "seostats"."seo_reports" SET "content_id" = NULL
 WHERE "content_id" IN (SELECT "id" FROM "seostats"."contents" WHERE "type" IN ('gmb', 'linkedin'));
DELETE FROM "seostats"."contents" WHERE "type" IN ('gmb', 'linkedin');
DELETE FROM "seostats"."content_types" WHERE "slug" IN ('gmb', 'linkedin');

-- 4. Colonnes GMB ────────────────────────────────────────────────────

ALTER TABLE "seostats"."projects" DROP COLUMN "gmb_location_id";
ALTER TABLE "seostats"."contents" DROP COLUMN "gmb_post_id";

COMMIT;
