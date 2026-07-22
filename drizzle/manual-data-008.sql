-- DATA-008 — Rétention, agrégation & purge (SPEC §7.11). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (retention_policies, observation_aggregates, purge_runs).
-- Appliqué par scripts/apply-data-008.ts. Aucune donnée touchée, aucun DROP.
-- Rétention configurable par type ; une donnée protégée / à rétention infinie n'est jamais purgée ;
-- une suppression d'audit exige L4 (invariants portés par retention-state.ts). Purge = dry-run d'abord.

-- 1. Retention policies (configurable par type) ────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"data_type" text NOT NULL,
	"category" text NOT NULL,
	"retention_days" integer,
	"aggregate_before_purge" boolean NOT NULL DEFAULT false,
	"requires_l4" boolean NOT NULL DEFAULT false,
	"protected" boolean NOT NULL DEFAULT false,
	"source_table" text,
	"timestamp_column" text,
	"description" text,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "retention_policies_data_type_unique"
	ON "seostats"."retention_policies" ("data_type");
CREATE INDEX IF NOT EXISTS "idx_retention_policies_category"
	ON "seostats"."retention_policies" ("category");

-- 2. Observation aggregates (rollups avant purge) ──────────────────
CREATE TABLE IF NOT EXISTS "seostats"."observation_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"grain" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"dimensions_hash" text NOT NULL,
	"dimensions_json" text,
	"metrics_json" text,
	"sample_count" integer NOT NULL DEFAULT 0,
	"computed_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "observation_aggregates_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "observation_aggregates_unique"
	ON "seostats"."observation_aggregates" ("project_id", "source", "grain", "period_start", "dimensions_hash");
CREATE INDEX IF NOT EXISTS "idx_observation_aggregates_source_grain"
	ON "seostats"."observation_aggregates" ("project_id", "source", "grain");

-- 3. Purge runs (observables, reprenables) ─────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."purge_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL DEFAULT 'planned',
	"dry_run" boolean NOT NULL DEFAULT true,
	"triggered_by" text,
	"approval_ref" text,
	"policy_version" integer,
	"plan_json" text,
	"metrics_json" text,
	"checkpoint_json" text,
	"error_message" text,
	"started_at" text,
	"finished_at" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "purge_runs_approval_ref_proposal_approvals_id_fk"
		FOREIGN KEY ("approval_ref") REFERENCES "seostats"."proposal_approvals"("id")
);
CREATE INDEX IF NOT EXISTS "idx_purge_runs_status"
	ON "seostats"."purge_runs" ("status");
