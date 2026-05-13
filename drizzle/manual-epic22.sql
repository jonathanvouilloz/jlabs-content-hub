-- Epic 22 — GMB profile management (lecture + édition + insights)
-- Migration manuelle additive : à exécuter via `turso db shell` ou `npm run db:push`
-- Strictement additif : aucune table droppée, aucune colonne modifiée.

-- 1. Snapshot fiche GMB par location
CREATE TABLE `gmb_location_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`gmb_location_id` text NOT NULL,
	`title` text NOT NULL,
	`phone` text,
	`website_uri` text,
	`store_code` text,
	`primary_category_display` text,
	`primary_category_id` text,
	`formatted_address` text,
	`latitude` real,
	`longitude` real,
	`open_status` text,
	`storefront_address` text,
	`additional_phones` text,
	`additional_categories` text,
	`regular_hours` text,
	`special_hours` text,
	`service_items` text,
	`profile_description` text,
	`labels` text,
	`attributes` text,
	`raw_payload` text,
	`etag` text,
	`synced_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `gmb_loc_profile_unique` ON `gmb_location_profiles` (`project_id`,`gmb_location_id`);
CREATE INDEX `idx_gmb_loc_profile_synced` ON `gmb_location_profiles` (`synced_at`);

-- 2. Métriques journalières Performance API
CREATE TABLE `gmb_insights_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`gmb_location_id` text NOT NULL,
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `gmb_insights_unique` ON `gmb_insights_daily` (`gmb_location_id`,`date`,`metric`);
CREATE INDEX `idx_gmb_insights_proj_date` ON `gmb_insights_daily` (`project_id`,`date`);

-- 3. Audit log éditions de fiche
CREATE TABLE `gmb_profile_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`gmb_location_id` text NOT NULL,
	`section` text NOT NULL,
	`update_mask` text,
	`payload` text NOT NULL,
	`success` integer NOT NULL,
	`error_message` text,
	`changed_by` text DEFAULT 'admin' NOT NULL,
	`changed_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_gmb_edits_loc_date` ON `gmb_profile_edits` (`gmb_location_id`,`changed_at`);
