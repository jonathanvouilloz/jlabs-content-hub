-- JOB-003 — Retry, backoff avec jitter et dead-letter (BACKLOG E02). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (tables `jobs` et `job_attempts`).
-- Appliqué par scripts/apply-job-003.ts.
-- Aucune table créée, aucune donnée touchée, aucun DROP : 4 colonnes + 1 index partiel.
--
-- Pourquoi ces colonnes :
--   - `last_error_class` : jusqu'ici toute erreur était traitée à l'identique. La CLASSE
--     (retryable | quota | auth | permanent) est ce qui décide du sort du job — et ce qui
--     rend la dead-letter filtrable (« montre-moi ce qui est mort d'un problème d'auth »).
--   - `deferrals` : un 429 n'est pas une faute du job. Sa tentative lui est RENDUE, et c'est
--     ce compteur SÉPARÉ qui borne la boucle — sans quoi un provider saturé enverrait en
--     dead-letter un job parfaitement sain, ou bouclerait sans fin s'il ne comptait rien.
--   - `requeued_count` : combien de fois un humain a relancé ce job depuis la dead-letter
--     (miroir de `findings.reopen_count`). Le compteur `attempts` étant remis à zéro à la
--     reprise, c'est lui qui garde la trace côté job ; le détail vit dans `job_attempts`.
--   - `job_attempts.error_class` : pourquoi CETTE tentative-là a échoué. `jobs.last_error_*`
--     est écrasé à chaque reprise ; le journal, lui, est append-only.
--
-- ⚠ Colonnes temporelles = `text` au format DB 'YYYY-MM-DD HH:MM:SS' (cf. src/lib/server/timestamps.ts).
--   Tout prédicat SQL sur `available_at`/`finished_at` doit CASTER (`::timestamp`) : une comparaison
--   lexicale est fausse dès que deux formats coexistent dans la colonne.

ALTER TABLE "seostats"."jobs" ADD COLUMN IF NOT EXISTS "last_error_class" text;
ALTER TABLE "seostats"."jobs" ADD COLUMN IF NOT EXISTS "deferrals" integer NOT NULL DEFAULT 0;
ALTER TABLE "seostats"."jobs" ADD COLUMN IF NOT EXISTS "requeued_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "seostats"."job_attempts" ADD COLUMN IF NOT EXISTS "error_class" text;

-- Index PARTIEL : le listing de la dead-letter ne scanne jamais toute la file.
CREATE INDEX IF NOT EXISTS "idx_jobs_dead"
	ON "seostats"."jobs" ("finished_at")
	WHERE status = 'dead';
