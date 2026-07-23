-- JOB-006 — Limites de concurrence et quotas provider (BACKLOG E02). Phase expand, additif, idempotent.
-- Miroir fidèle de src/lib/server/db/schema.ts (table `system_settings`).
-- Appliqué par scripts/apply-job-006.ts.
-- UNE table créée, vide, sans donnée migrée, aucun DROP, aucune colonne existante touchée.
--
-- Pourquoi une table alors que JOB-004/005/007 n'en ont créé aucune : le « zéro DDL »
-- de ces lots était un CONSTAT (« tout était déjà là depuis DATA-003 »), pas une règle.
-- Ici il n'y a rien. L'acceptation JOB-006 exige des limites « configurables sans
-- redéploiement », et sur Vercel une variable d'environnement n'est relue qu'au
-- redéploiement : elle ne peut pas la tenir. `gmb_settings` est bien un KV et sert déjà
-- à des clés non-GMB (`critical_sent_*`), mais y ranger les quotas GSC ferait mentir son
-- nom à la prochaine lecture.
--
-- Portée : SYSTÈME uniquement (ce qui ne se range sous aucun projet). Les caps par
-- projet vivent dans `project_projections.payload.limits`, calque des `schedules` de
-- JOB-005 — deux maisons, deux portées, aucune ambiguïté sur qui gagne.
--
-- La table naît VIDE, et c'est voulu : sans ligne, `resolveLimits` rend les défauts de
-- `job-limits.ts`. Le comportement par défaut est donc celui du code, et la base ne sert
-- qu'à s'en écarter.
--
-- ⚠ `updated_at` = `text` au format DB 'YYYY-MM-DD HH:MM:SS' (cf. src/lib/server/timestamps.ts),
--   comme toutes les colonnes temporelles du schéma. Ne jamais y écrire un ISO
--   (`'T'` 0x54 > `' '` 0x20 : deux formats mélangés se comparent faux).

CREATE TABLE IF NOT EXISTS "seostats"."system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
