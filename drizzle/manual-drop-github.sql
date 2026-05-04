-- Drop GitHub backup columns from contents
-- Date : 2026-05-04
-- Contexte : suppression de la sync GitHub. Turso est désormais l'unique source de vérité.
-- Le code applicatif (src/lib/server/github.ts, imports dans api/content/*) a été retiré
-- dans le même commit. Cette migration aligne le schéma Turso.

-- Pré-requis SQLite : version >= 3.35 (DROP COLUMN). Turso/libSQL supporte.

ALTER TABLE `contents` DROP COLUMN `github_synced`;
ALTER TABLE `contents` DROP COLUMN `github_path`;
