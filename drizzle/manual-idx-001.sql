-- IDX-001 — Inventaire sitemap par URL. Phase expand, additif, idempotent.
-- Miroir fidèle de `sitemapUrlObservations` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-idx-001.ts. Aucune donnée touchée, aucun DROP.
--
-- Pourquoi une table et pas une réutilisation :
--   `sitemap_observations` porte le PAR-FICHIER, à la forme de l'API Sitemaps de GSC
--   (submitted/indexed/errors/warnings/pending). IDX-001 lit le XML et a besoin du
--   PAR-URL : lastmod, locale (hreflang), canonical attendu. Aucune table existante n'a
--   ce grain, et `payload_json` est plafonné à 32 Ko — un inventaire n'y tient pas.
--
-- Pourquoi un snapshot complet par date et pas un journal de changements :
--   le diff de deux dates devient une fonction PURE de deux listes (`diffInventories`),
--   donc « reproductible et lié à deux snapshots » au sens littéral de l'acceptation.
--   Un journal cumulé ne se rejoue pas — il faudrait le replier depuis l'origine.
--
-- ⚠️ L'unique porte `url_normalized`, PAS `url` : sans ça, `…/page` et `…/page#a`
--    créeraient deux lignes pour une seule page, et le diff inventerait un ajout à
--    chaque run. `url` garde la forme exacte déclarée (trace) ; `url_normalized` compare.
--
-- La table naît VIDE : appliquer ce DDL ne change aucun comportement.
-- Écart d'introspection ATTENDU : 57 → 58 tables `seostats`, et exactement celle-ci.

CREATE TABLE IF NOT EXISTS "seostats"."sitemap_url_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"provider" text NOT NULL DEFAULT 'gsc',
	"schema_version" integer NOT NULL DEFAULT 1,
	"observed_date" text NOT NULL,
	"sitemap_url" text NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"lastmod" text,
	"locale" text,
	"expected_canonical" text,
	"is_alternate" boolean NOT NULL DEFAULT false,
	"payload_json" text,
	"fetched_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "sitemap_url_observations_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "seostats"."projects"("id"),
	CONSTRAINT "sitemap_url_observations_run_id_monitoring_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "seostats"."monitoring_runs"("id")
);

-- Unique d'upsert : deux collectes du même jour ne dupliquent pas (acceptation DATA-004).
CREATE UNIQUE INDEX IF NOT EXISTS "sitemap_url_obs_unique"
	ON "seostats"."sitemap_url_observations" ("project_id", "url_normalized", "observed_date");

-- Fenêtres par date (le diff charge deux dates, jamais toute la table).
CREATE INDEX IF NOT EXISTS "idx_sitemap_url_obs_project_date"
	ON "seostats"."sitemap_url_observations" ("project_id", "observed_date");

-- Historique d'une URL donnée (« depuis quand cette page est-elle déclarée ? »).
CREATE INDEX IF NOT EXISTS "idx_sitemap_url_obs_project_url"
	ON "seostats"."sitemap_url_observations" ("project_id", "url_normalized");
