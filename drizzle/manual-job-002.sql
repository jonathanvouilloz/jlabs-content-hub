-- JOB-002 — Bail, tentatives et effets externes (BACKLOG E02). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts. Appliqué par scripts/apply-job-002.ts.
-- Aucune table modifiée, aucune donnée touchée, aucun DROP : 2 tables + 4 index.
--
-- Pourquoi ces deux tables :
--   - `job_attempts` : `jobs` ne garde qu'un COMPTEUR (`attempts`) et un `last_error_*`
--     écrasé à chaque reprise. Rien ne permet de montrer « la tentative #1 a été abandonnée
--     parce que son worker est mort, la #2 a réussi » — ce que l'acceptation JOB-002 exige,
--     et ce dont JOB-003 (reprise manuelle) puis JOB-007 (console) dépendront.
--   - `job_effects` : après reprise d'un job mort, le handler RE-TOURNE. Ce registre garantit
--     qu'un effet externe déjà appliqué n'est jamais rejoué.
--
-- ⚠ Colonnes temporelles = `text` au format DB 'YYYY-MM-DD HH:MM:SS' (cf. src/lib/server/timestamps.ts).
--   Tout prédicat SQL sur `lease_until`/`started_at` doit CASTER (`::timestamp`) : une comparaison
--   lexicale est fausse dès que deux formats coexistent dans la colonne.
--
-- ⚠ PAS d'unique sur (job_id, attempt_no) : `releaseJob` REND la tentative (attempts - 1),
--   donc un numéro se répète légitimement. Journal append-only, comme finding_events.

CREATE TABLE IF NOT EXISTS "seostats"."job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL REFERENCES "seostats"."jobs"("id"),
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"attempt_no" integer NOT NULL,
	"worker_id" text NOT NULL,
	"outcome" text NOT NULL DEFAULT 'running',
	"abandon_kind" text,
	"error_code" text,
	"error_message" text,
	"heartbeat_count" integer NOT NULL DEFAULT 0,
	"metadata_json" text,
	"started_at" text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"finished_at" text,
	"duration_ms" integer
);

CREATE INDEX IF NOT EXISTS "idx_job_attempts_job" ON "seostats"."job_attempts" ("job_id");
CREATE INDEX IF NOT EXISTS "idx_job_attempts_outcome" ON "seostats"."job_attempts" ("outcome");

CREATE TABLE IF NOT EXISTS "seostats"."job_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL REFERENCES "seostats"."jobs"("id"),
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"attempt_no" integer,
	"effect_key" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"result_hash" text,
	"error_message" text,
	"claimed_at" text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
	"applied_at" text
);

-- Le cœur de l'exactly-once : réserver cette clé est ce qui interdit le double effet.
CREATE UNIQUE INDEX IF NOT EXISTS "job_effects_key_unique"
	ON "seostats"."job_effects" ("project_id", "effect_key");
CREATE INDEX IF NOT EXISTS "idx_job_effects_job" ON "seostats"."job_effects" ("job_id");
