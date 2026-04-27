-- Epic 18 — GMB full-auto pipeline
-- Migration manuelle additive : à exécuter via `turso db shell` ou `npm run db:push`
-- Strictement additif : aucune table droppée, aucune colonne modifiée.

-- 1. Ajouter colonnes notifications client sur projects
ALTER TABLE `projects` ADD COLUMN `client_email` text;
ALTER TABLE `projects` ADD COLUMN `weekly_digest_enabled` integer DEFAULT 0 NOT NULL;

-- 2. Créer table publish_logs
CREATE TABLE `publish_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`project_id` text NOT NULL,
	`channel` text DEFAULT 'gmb' NOT NULL,
	`location_id` text,
	`location_label` text,
	`success` integer NOT NULL,
	`gmb_post_id` text,
	`error_message` text,
	`attempted_at` text DEFAULT (datetime('now')) NOT NULL,
	`duration_ms` integer,
	`source` text DEFAULT 'cron' NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_publish_logs_project_date` ON `publish_logs` (`project_id`,`attempted_at`);
CREATE INDEX `idx_publish_logs_content` ON `publish_logs` (`content_id`);
