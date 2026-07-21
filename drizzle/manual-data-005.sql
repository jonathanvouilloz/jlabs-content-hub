-- DATA-005 — Findings & journal de décisions (SPEC §7.6/§7.7). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (findings, finding_events).
-- Appliqué par scripts/apply-data-005.ts. Aucune donnée touchée, aucun DROP.
-- Un finding = interprétation déterministe persistante (fingerprint stable → dédup).
-- finding_events = journal APPEND-ONLY : toute transition a event_type + reason + actor.

-- 1. Findings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"fingerprint" text NOT NULL,
	"type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_key" text NOT NULL DEFAULT '',
	"title" text NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"severity" text NOT NULL DEFAULT 'info',
	"priority_score" integer NOT NULL DEFAULT 0,
	"confidence_score" integer NOT NULL DEFAULT 0,
	"impact_estimate_json" text,
	"evidence_json" text,
	"detector_version" text,
	"recommended_skill" text,
	"occurrence_count" integer NOT NULL DEFAULT 1,
	"first_seen_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"last_seen_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"resolution_reason" text,
	"resolved_at" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "findings_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "findings_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "findings_fingerprint_unique"
	ON "seostats"."findings" ("project_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "idx_findings_project_status"
	ON "seostats"."findings" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_findings_project_severity"
	ON "seostats"."findings" ("project_id", "severity");
CREATE INDEX IF NOT EXISTS "idx_findings_status"
	ON "seostats"."findings" ("status");

-- 2. Finding events (journal append-only) ──────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."finding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"actor" text NOT NULL DEFAULT 'system',
	"payload_json" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "finding_events_finding_id_findings_id_fk"
		FOREIGN KEY ("finding_id") REFERENCES "seostats"."findings"("id"),
	CONSTRAINT "finding_events_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);
CREATE INDEX IF NOT EXISTS "idx_finding_events_finding"
	ON "seostats"."finding_events" ("finding_id");
CREATE INDEX IF NOT EXISTS "idx_finding_events_project_created"
	ON "seostats"."finding_events" ("project_id", "created_at");
