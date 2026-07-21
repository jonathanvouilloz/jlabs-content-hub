-- DATA-006 — Propositions, approbations & agent runs (SPEC §7.8/§7.9/§12). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (action_proposals, proposal_approvals, agent_runs).
-- Appliqué par scripts/apply-data-006.ts. Aucune donnée touchée, aucun DROP.
-- Une approbation est liée au payload_hash exact de la proposition (§12.2) ; un agent
-- ne peut pas s'auto-accorder un niveau supérieur (invariant porté par proposal-state.ts).
-- Exécution/vérification NON séparées : via execution_job_id (→ jobs) + verification_status.

-- 1. Action proposals ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."action_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"finding_id" text,
	"action_type" text NOT NULL,
	"target" text,
	"rationale" text,
	"expected_impact" text,
	"risk_level" text,
	"required_approval_level" text NOT NULL DEFAULT 'L2',
	"proposed_by" text NOT NULL DEFAULT 'agent',
	"payload_json" text,
	"payload_hash" text NOT NULL,
	"input_hashes_json" text,
	"status" text NOT NULL DEFAULT 'proposed',
	"approved_by" text,
	"approved_at" text,
	"execution_job_id" text,
	"verification_status" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "action_proposals_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "action_proposals_finding_id_findings_id_fk"
		FOREIGN KEY ("finding_id") REFERENCES "seostats"."findings"("id"),
	CONSTRAINT "action_proposals_execution_job_id_jobs_id_fk"
		FOREIGN KEY ("execution_job_id") REFERENCES "seostats"."jobs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "action_proposals_idem_unique"
	ON "seostats"."action_proposals" ("project_id", "finding_id", "action_type", "payload_hash");
CREATE INDEX IF NOT EXISTS "idx_action_proposals_project_status"
	ON "seostats"."action_proposals" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_action_proposals_finding"
	ON "seostats"."action_proposals" ("finding_id");
CREATE INDEX IF NOT EXISTS "idx_action_proposals_status"
	ON "seostats"."action_proposals" ("status");

-- 2. Proposal approvals (entité d'approbation, hash lié) ────────────
CREATE TABLE IF NOT EXISTS "seostats"."proposal_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"project_id" text NOT NULL,
	"approved_payload_hash" text NOT NULL,
	"approver_type" text NOT NULL DEFAULT 'user',
	"approver_id" text,
	"scope_json" text,
	"method" text NOT NULL DEFAULT 'ui',
	"token" text,
	"token_used_at" text,
	"expires_at" text,
	"status" text NOT NULL DEFAULT 'active',
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "proposal_approvals_proposal_id_action_proposals_id_fk"
		FOREIGN KEY ("proposal_id") REFERENCES "seostats"."action_proposals"("id"),
	CONSTRAINT "proposal_approvals_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id")
);
CREATE INDEX IF NOT EXISTS "idx_proposal_approvals_proposal"
	ON "seostats"."proposal_approvals" ("proposal_id");
CREATE INDEX IF NOT EXISTS "idx_proposal_approvals_project_status"
	ON "seostats"."proposal_approvals" ("project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_approvals_token_unique"
	ON "seostats"."proposal_approvals" ("token");

-- 3. Agent runs (journal d'invocation) ─────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"proposal_id" text,
	"human_validation_ref" text,
	"agent" text NOT NULL,
	"agent_version" text,
	"skill" text,
	"model" text,
	"input_hashes_json" text,
	"findings_read_json" text,
	"output_type" text,
	"output_ref" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"cost_json" text,
	"duration_ms" integer,
	"status" text NOT NULL DEFAULT 'running',
	"result_json" text,
	"error_code" text,
	"error_message" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"finished_at" text,
	CONSTRAINT "agent_runs_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "agent_runs_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id"),
	CONSTRAINT "agent_runs_proposal_id_action_proposals_id_fk"
		FOREIGN KEY ("proposal_id") REFERENCES "seostats"."action_proposals"("id"),
	CONSTRAINT "agent_runs_human_validation_ref_proposal_approvals_id_fk"
		FOREIGN KEY ("human_validation_ref") REFERENCES "seostats"."proposal_approvals"("id")
);
CREATE INDEX IF NOT EXISTS "idx_agent_runs_project_status"
	ON "seostats"."agent_runs" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_agent_runs_proposal"
	ON "seostats"."agent_runs" ("proposal_id");
CREATE INDEX IF NOT EXISTS "idx_agent_runs_run"
	ON "seostats"."agent_runs" ("run_id");
