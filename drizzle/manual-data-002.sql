-- DATA-002 — Intégrations & projections (phase expand, additif, idempotent).
-- Miroir fidèle de src/lib/server/db/schema.ts (projectIntegrations / projectProjections).
-- Appliqué par scripts/apply-data-002.ts. Aucune donnée touchée, aucun DROP.

CREATE TABLE IF NOT EXISTS "seostats"."project_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"resource_key" text NOT NULL DEFAULT '',
	"enabled" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'inactive',
	"scopes" text,
	"configuration_json" text,
	"secret_ref" text,
	"last_success_at" text,
	"last_error_at" text,
	"last_error_code" text,
	"health_status" text NOT NULL DEFAULT 'unknown',
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "project_integrations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_integrations_unique"
	ON "seostats"."project_integrations" ("project_id", "provider", "resource_key");
CREATE INDEX IF NOT EXISTS "idx_project_integrations_provider"
	ON "seostats"."project_integrations" ("provider");
CREATE INDEX IF NOT EXISTS "idx_project_integrations_project"
	ON "seostats"."project_integrations" ("project_id");

CREATE TABLE IF NOT EXISTS "seostats"."project_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"schema_version" integer NOT NULL DEFAULT 1,
	"source_hash" text NOT NULL,
	"payload" text NOT NULL,
	"status" text NOT NULL DEFAULT 'current',
	"validation_errors" text,
	"compiled_at" text,
	"received_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "project_projections_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_projections_hash_unique"
	ON "seostats"."project_projections" ("project_id", "source_hash");
-- Une seule projection `current` par projet (unique partiel).
CREATE UNIQUE INDEX IF NOT EXISTS "project_projections_one_current"
	ON "seostats"."project_projections" ("project_id") WHERE "status" = 'current';
CREATE INDEX IF NOT EXISTS "idx_project_projections_project_status"
	ON "seostats"."project_projections" ("project_id", "status");
