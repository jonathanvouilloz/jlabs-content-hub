-- Pipeline SEO V2 — table seo_reports (concurrence / backlinks / visibilité IA)
-- Migration manuelle additive : à exécuter via `turso db shell` ou `npm run db:push`
-- Strictement additif : aucune table droppée, aucune colonne modifiée.

CREATE TABLE `seo_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_id` text,
	`report_type` text NOT NULL,
	`target` text,
	`payload` text NOT NULL,
	`score` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `seo_reports_project_type` ON `seo_reports` (`project_id`,`report_type`);
CREATE INDEX `seo_reports_content` ON `seo_reports` (`content_id`);
