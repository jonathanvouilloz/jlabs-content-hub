-- DATA-010 - API agent avis v1 : idempotence explicite, audit, mentions candidates et recaps.
-- Migration additive et rejouable. Aucun DROP, aucune donnee existante reecrite.

ALTER TABLE "seostats"."review_reply_proposals"
	ADD COLUMN IF NOT EXISTS "idempotency_key" text,
	ADD COLUMN IF NOT EXISTS "requested_by" text;

CREATE UNIQUE INDEX IF NOT EXISTS "review_reply_proposals_idempotency_unique"
	ON "seostats"."review_reply_proposals" ("project_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "seostats"."review_reply_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL REFERENCES "seostats"."review_reply_deliveries"("id"),
	"proposal_id" text NOT NULL REFERENCES "seostats"."review_reply_proposals"("id"),
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"state" text NOT NULL,
	"detail_json" text,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS "idx_review_reply_delivery_events_delivery"
	ON "seostats"."review_reply_delivery_events" ("delivery_id", "created_at");

CREATE TABLE IF NOT EXISTS "seostats"."review_mention_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"review_id" text NOT NULL,
	"location_id" text NOT NULL,
	"detected_token" text NOT NULL,
	"normalized_token" text NOT NULL,
	"sentiment" text NOT NULL,
	"evidence" text NOT NULL,
	"confidence" double precision NOT NULL,
	"roster_version" text,
	"status" text NOT NULL DEFAULT 'candidate',
	"resolution_json" text,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "review_mention_candidates_sentiment_check" CHECK ("sentiment" IN ('positive', 'neutral', 'negative')),
	CONSTRAINT "review_mention_candidates_status_check" CHECK ("status" IN ('candidate', 'validated', 'rejected', 'resolved')),
	CONSTRAINT "review_mention_candidates_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_mention_candidates_idempotency_unique"
	ON "seostats"."review_mention_candidates" ("project_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_review_mention_candidates_review"
	ON "seostats"."review_mention_candidates" ("project_id", "review_id");
CREATE INDEX IF NOT EXISTS "idx_review_mention_candidates_status"
	ON "seostats"."review_mention_candidates" ("project_id", "status");

CREATE TABLE IF NOT EXISTS "seostats"."review_monthly_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "seostats"."projects"("id"),
	"period_key" text NOT NULL,
	"timezone" text NOT NULL DEFAULT 'Europe/Zurich',
	"revision" integer NOT NULL DEFAULT 1,
	"payload_json" text NOT NULL,
	"payload_hash" text NOT NULL,
	"supersedes_id" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "review_monthly_reports_timezone_check" CHECK ("timezone" = 'Europe/Zurich')
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_monthly_reports_revision_unique"
	ON "seostats"."review_monthly_reports" ("project_id", "period_key", "revision");
CREATE UNIQUE INDEX IF NOT EXISTS "review_monthly_reports_payload_unique"
	ON "seostats"."review_monthly_reports" ("project_id", "period_key", "payload_hash");
CREATE INDEX IF NOT EXISTS "idx_review_monthly_reports_period"
	ON "seostats"."review_monthly_reports" ("project_id", "period_key");
