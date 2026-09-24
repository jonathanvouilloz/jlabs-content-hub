-- DATA-009 — GMB-004→007 : candidats de réponse immuables et journal de livraison.
-- Phase expand, additive et idempotente. Aucun DROP, aucune donnée existante touchée.

CREATE TABLE IF NOT EXISTS "seostats"."review_reply_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"review_id" text NOT NULL,
	"location_id" text NOT NULL,
	"review_snapshot_hash" text NOT NULL,
	"review_rating" integer NOT NULL,
	"review_comment" text NOT NULL,
	"remote_update_at" text,
	"proposal_hash" text NOT NULL,
	"reply_text" text NOT NULL,
	"language" text NOT NULL,
	"projection_id" text REFERENCES "seostats"."project_projections"("id"),
	"projection_hash" text NOT NULL,
	"policy_id" text REFERENCES "seostats"."review_automation_policies"("id"),
	"policy_version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"gate_status" text NOT NULL,
	"gate_reasons_json" text NOT NULL,
	"state" text NOT NULL DEFAULT 'drafted',
	"scheduled_at" text,
	"reservation_id" text,
	"reserved_at" text,
	"sent_at" text,
	"verified_at" text,
	"cancelled_at" text,
	"cancellation_reason" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_reply_proposals_candidate_unique"
	ON "seostats"."review_reply_proposals" ("project_id", "review_id", "review_snapshot_hash", "proposal_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "review_reply_proposals_one_live_review"
	ON "seostats"."review_reply_proposals" ("project_id", "review_id")
	WHERE "state" NOT IN ('verified', 'conflict', 'cancelled');
CREATE INDEX IF NOT EXISTS "idx_review_reply_proposals_publishable"
	ON "seostats"."review_reply_proposals" ("state", "scheduled_at");
CREATE INDEX IF NOT EXISTS "idx_review_reply_proposals_project_review"
	ON "seostats"."review_reply_proposals" ("project_id", "review_id");

CREATE TABLE IF NOT EXISTS "seostats"."review_reply_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL REFERENCES "seostats"."review_reply_proposals"("id"),
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"effect_key" text NOT NULL,
	"attempt_no" integer NOT NULL DEFAULT 1,
	"state" text NOT NULL,
	"outbound_body_hash" text NOT NULL,
	"http_status" integer,
	"error_class" text,
	"error_message" text,
	"remote_reply_text" text,
	"remote_reply_at" text,
	"verified_at" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_reply_deliveries_effect_unique"
	ON "seostats"."review_reply_deliveries" ("project_id", "effect_key");
CREATE INDEX IF NOT EXISTS "idx_review_reply_deliveries_proposal"
	ON "seostats"."review_reply_deliveries" ("proposal_id", "created_at");
