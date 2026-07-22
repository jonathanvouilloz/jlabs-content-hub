-- DATA-007 — Politiques d'avis & d'automatisation (SPEC §7.10). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (review_automation_policies, policy_promotions).
-- Appliqué par scripts/apply-data-007.ts. Aucune donnée touchée, aucun DROP.
-- Une policy est VERSIONNÉE (une seule courante par scope) → une ancienne proposition ne
-- profite jamais silencieusement d'une nouvelle policy. Le kill switch bloque les ENVOIS
-- sans bloquer la sync (invariant porté par policy-state.ts). Toute promotion est journalisée.

-- 1. Review automation policies (versionnées) ──────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."review_automation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"location_id" text,
	"scope_key" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"policy_hash" text NOT NULL,
	"mode" text NOT NULL DEFAULT 'draft_only',
	"sync_enabled" boolean NOT NULL DEFAULT true,
	"auto_generation_enabled" boolean NOT NULL DEFAULT false,
	"kill_switch" boolean NOT NULL DEFAULT false,
	"min_rating_for_auto_send" integer,
	"send_delay_minutes" integer,
	"jitter_minutes" integer,
	"send_windows_json" text,
	"default_language" text,
	"signature" text,
	"escalation_categories_json" text,
	"max_sends_per_run" integer,
	"status" text NOT NULL DEFAULT 'current',
	"promoted_by" text,
	"promoted_at" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "review_automation_policies_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_automation_policies_version_unique"
	ON "seostats"."review_automation_policies" ("project_id", "scope_key", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "review_automation_policies_one_current"
	ON "seostats"."review_automation_policies" ("project_id", "scope_key")
	WHERE status = 'current';
CREATE INDEX IF NOT EXISTS "idx_review_automation_policies_project_status"
	ON "seostats"."review_automation_policies" ("project_id", "status");

-- 2. Policy promotions (journal append-only) ───────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."policy_promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"from_policy_id" text,
	"scope_key" text NOT NULL,
	"from_version" integer,
	"to_version" integer NOT NULL,
	"from_mode" text,
	"to_mode" text NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "policy_promotions_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "policy_promotions_policy_id_review_automation_policies_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "seostats"."review_automation_policies"("id"),
	CONSTRAINT "policy_promotions_from_policy_id_review_automation_policies_id_fk"
		FOREIGN KEY ("from_policy_id") REFERENCES "seostats"."review_automation_policies"("id")
);
CREATE INDEX IF NOT EXISTS "idx_policy_promotions_policy"
	ON "seostats"."policy_promotions" ("policy_id");
CREATE INDEX IF NOT EXISTS "idx_policy_promotions_project_scope"
	ON "seostats"."policy_promotions" ("project_id", "scope_key");
