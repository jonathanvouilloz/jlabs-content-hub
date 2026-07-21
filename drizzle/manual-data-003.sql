-- DATA-003 — Runs, steps & queue de jobs durable (phase expand, additif, idempotent).
-- Miroir fidèle de src/lib/server/db/schema.ts (monitoringRuns / monitoringSteps / jobs).
-- Appliqué par scripts/apply-data-003.ts. Aucune donnée touchée, aucun DROP.

CREATE TABLE IF NOT EXISTS "seostats"."monitoring_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_type" text NOT NULL,
	"period_start" text,
	"period_end" text,
	"status" text NOT NULL DEFAULT 'queued',
	"idempotency_key" text NOT NULL,
	"triggered_by" text NOT NULL DEFAULT 'schedule',
	"started_at" text,
	"finished_at" text,
	"summary_json" text,
	"cost_json" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "monitoring_runs_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "monitoring_runs_idempotency_unique"
	ON "seostats"."monitoring_runs" ("project_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_monitoring_runs_project_status"
	ON "seostats"."monitoring_runs" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_monitoring_runs_status"
	ON "seostats"."monitoring_runs" ("status");

CREATE TABLE IF NOT EXISTS "seostats"."monitoring_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_type" text NOT NULL,
	"provider" text,
	"status" text NOT NULL DEFAULT 'queued',
	"attempt" integer NOT NULL DEFAULT 1,
	"lease_owner" text,
	"lease_until" text,
	"input_hash" text,
	"output_hash" text,
	"started_at" text,
	"finished_at" text,
	"duration_ms" integer,
	"error_code" text,
	"error_message" text,
	"metadata_json" text,
	CONSTRAINT "monitoring_steps_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "monitoring_steps_run_type_attempt_unique"
	ON "seostats"."monitoring_steps" ("run_id", "step_type", "attempt");
CREATE INDEX IF NOT EXISTS "idx_monitoring_steps_run"
	ON "seostats"."monitoring_steps" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_monitoring_steps_run_status"
	ON "seostats"."monitoring_steps" ("run_id", "status");

CREATE TABLE IF NOT EXISTS "seostats"."jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"status" text NOT NULL DEFAULT 'queued',
	"idempotency_key" text NOT NULL,
	"priority" integer NOT NULL DEFAULT 0,
	"payload_json" text,
	"attempts" integer NOT NULL DEFAULT 0,
	"max_attempts" integer NOT NULL DEFAULT 5,
	"available_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"lease_owner" text,
	"lease_until" text,
	"heartbeat_at" text,
	"depends_on" text,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"finished_at" text,
	CONSTRAINT "jobs_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "jobs_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "jobs_idempotency_unique"
	ON "seostats"."jobs" ("project_id", "idempotency_key");
-- Index de réclamation vérifié (JOB-001 : FOR UPDATE SKIP LOCKED sur status/available_at/priority).
CREATE INDEX IF NOT EXISTS "idx_jobs_claim"
	ON "seostats"."jobs" ("status", "available_at", "priority");
CREATE INDEX IF NOT EXISTS "idx_jobs_project_status"
	ON "seostats"."jobs" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_jobs_lease"
	ON "seostats"."jobs" ("lease_until");
