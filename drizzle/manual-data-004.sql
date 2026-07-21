-- DATA-004 — Modèle d'observations, 10 tables (SPEC §7.5). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (gsc_query_page_observations … gmb_insight_observations).
-- Appliqué par scripts/apply-data-004.ts. Aucune donnée touchée, aucun DROP.
-- Contrat commun par table : project_id, run_id (nullable, traçabilité), provider,
-- schema_version, période/date, dimensions, métriques, payload_json (brut borné),
-- fetched_at ; unique d'upsert (dédup) ; index (projet, période) pour 7/28/90 j.

-- 1. GSC query×page×device ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."gsc_query_page_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gsc',
	"schema_version" integer NOT NULL DEFAULT 1,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"query" text NOT NULL,
	"page" text NOT NULL,
	"device" text NOT NULL DEFAULT '',
	"clicks" integer NOT NULL DEFAULT 0,
	"impressions" integer NOT NULL DEFAULT 0,
	"ctr" double precision NOT NULL DEFAULT 0,
	"position" double precision NOT NULL DEFAULT 0,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "gsc_query_page_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "gsc_query_page_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_qp_obs_unique"
	ON "seostats"."gsc_query_page_observations" ("project_id", "period_start", "query", "page", "device");
CREATE INDEX IF NOT EXISTS "idx_gsc_qp_obs_project_period"
	ON "seostats"."gsc_query_page_observations" ("project_id", "period_start");
CREATE INDEX IF NOT EXISTS "idx_gsc_qp_obs_project_query"
	ON "seostats"."gsc_query_page_observations" ("project_id", "query");
CREATE INDEX IF NOT EXISTS "idx_gsc_qp_obs_project_page"
	ON "seostats"."gsc_query_page_observations" ("project_id", "page");

-- 2. GSC agrégat page×device ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."gsc_page_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gsc',
	"schema_version" integer NOT NULL DEFAULT 1,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"page" text NOT NULL,
	"device" text NOT NULL DEFAULT '',
	"clicks" integer NOT NULL DEFAULT 0,
	"impressions" integer NOT NULL DEFAULT 0,
	"ctr" double precision NOT NULL DEFAULT 0,
	"position" double precision NOT NULL DEFAULT 0,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "gsc_page_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "gsc_page_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_page_obs_unique"
	ON "seostats"."gsc_page_observations" ("project_id", "period_start", "page", "device");
CREATE INDEX IF NOT EXISTS "idx_gsc_page_obs_project_period"
	ON "seostats"."gsc_page_observations" ("project_id", "period_start");
CREATE INDEX IF NOT EXISTS "idx_gsc_page_obs_project_page"
	ON "seostats"."gsc_page_observations" ("project_id", "page");

-- 3. Indexation / URL Inspection ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."index_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'indexing',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"url" text NOT NULL,
	"coverage_state" text,
	"verdict" text,
	"indexing_state" text,
	"robots_state" text,
	"google_canonical" text,
	"user_canonical" text,
	"last_crawl_at" text,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "index_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "index_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "index_obs_unique"
	ON "seostats"."index_observations" ("project_id", "url", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_index_obs_project_date"
	ON "seostats"."index_observations" ("project_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_index_obs_project_coverage"
	ON "seostats"."index_observations" ("project_id", "coverage_state");

-- 4. Sitemap ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."sitemap_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gsc',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"sitemap_url" text NOT NULL,
	"submitted_urls" integer NOT NULL DEFAULT 0,
	"indexed_urls" integer NOT NULL DEFAULT 0,
	"errors" integer NOT NULL DEFAULT 0,
	"warnings" integer NOT NULL DEFAULT 0,
	"is_pending" boolean NOT NULL DEFAULT false,
	"last_submitted_at" text,
	"last_downloaded_at" text,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "sitemap_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "sitemap_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "sitemap_obs_unique"
	ON "seostats"."sitemap_observations" ("project_id", "sitemap_url", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_sitemap_obs_project_date"
	ON "seostats"."sitemap_observations" ("project_id", "observed_date");

-- 5. Analytics page (Plausible) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."plausible_page_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'plausible',
	"schema_version" integer NOT NULL DEFAULT 1,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"page" text NOT NULL,
	"visitors" integer NOT NULL DEFAULT 0,
	"pageviews" integer NOT NULL DEFAULT 0,
	"bounce_rate" double precision NOT NULL DEFAULT 0,
	"visit_duration" double precision NOT NULL DEFAULT 0,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "plausible_page_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "plausible_page_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plausible_page_obs_unique"
	ON "seostats"."plausible_page_observations" ("project_id", "period_start", "page");
CREATE INDEX IF NOT EXISTS "idx_plausible_page_obs_project_period"
	ON "seostats"."plausible_page_observations" ("project_id", "period_start");
CREATE INDEX IF NOT EXISTS "idx_plausible_page_obs_project_page"
	ON "seostats"."plausible_page_observations" ("project_id", "page");

-- 6. Positions mot-clé ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."keyword_rank_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gsc',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"keyword" text NOT NULL,
	"device" text NOT NULL DEFAULT '',
	"page" text,
	"position" double precision NOT NULL DEFAULT 0,
	"clicks" integer,
	"impressions" integer,
	"ctr" double precision,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "keyword_rank_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "keyword_rank_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "keyword_rank_obs_unique"
	ON "seostats"."keyword_rank_observations" ("project_id", "keyword", "device", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_keyword_rank_obs_project_date"
	ON "seostats"."keyword_rank_observations" ("project_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_keyword_rank_obs_project_keyword"
	ON "seostats"."keyword_rank_observations" ("project_id", "keyword");

-- 7. Backlinks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."backlink_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'dataforseo',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"source_url" text NOT NULL,
	"target_url" text NOT NULL,
	"anchor" text,
	"dofollow" boolean,
	"spam_score" integer,
	"domain_rating" double precision,
	"first_seen_at" text,
	"last_seen_at" text,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "backlink_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "backlink_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "backlink_obs_unique"
	ON "seostats"."backlink_observations" ("project_id", "source_url", "target_url", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_backlink_obs_project_date"
	ON "seostats"."backlink_observations" ("project_id", "observed_date");

-- 8. Visibilité IA / GEO ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."ai_visibility_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'ai',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"engine" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"prompt_text" text,
	"cited" boolean NOT NULL DEFAULT false,
	"score" integer,
	"position" double precision,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "ai_visibility_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "ai_visibility_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_visibility_obs_unique"
	ON "seostats"."ai_visibility_observations" ("project_id", "engine", "prompt_hash", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_ai_visibility_obs_project_date"
	ON "seostats"."ai_visibility_observations" ("project_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_ai_visibility_obs_project_engine"
	ON "seostats"."ai_visibility_observations" ("project_id", "engine");

-- 9. Avis GMB comme observation d'état ─────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."gmb_review_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gmb',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"location_id" text NOT NULL,
	"review_id" text NOT NULL,
	"rating" integer,
	"sentiment" text,
	"has_reply" boolean NOT NULL DEFAULT false,
	"reply_latency_hours" integer,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "gmb_review_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "gmb_review_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "gmb_review_obs_unique"
	ON "seostats"."gmb_review_observations" ("project_id", "review_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_gmb_review_obs_project_date"
	ON "seostats"."gmb_review_observations" ("project_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_gmb_review_obs_project_location"
	ON "seostats"."gmb_review_observations" ("project_id", "location_id");

-- 10. Métriques Performance GMB ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seostats"."gmb_insight_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gmb',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"location_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" integer NOT NULL DEFAULT 0,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "gmb_insight_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "gmb_insight_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "gmb_insight_obs_unique"
	ON "seostats"."gmb_insight_observations" ("project_id", "location_id", "observed_date", "metric");
CREATE INDEX IF NOT EXISTS "idx_gmb_insight_obs_project_date"
	ON "seostats"."gmb_insight_observations" ("project_id", "observed_date");
CREATE INDEX IF NOT EXISTS "idx_gmb_insight_obs_location_date"
	ON "seostats"."gmb_insight_observations" ("location_id", "observed_date");
