CREATE TABLE `crawl_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`stats` text
);
--> statement-breakpoint
CREATE TABLE `postings` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_key` text NOT NULL,
	`url` text NOT NULL,
	`apply_url` text,
	`source_id` text NOT NULL,
	`external_id` text,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text NOT NULL,
	`salary_raw` text,
	`description` text,
	`posted_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`delisted_at` integer,
	`persona` text NOT NULL,
	`tz_band` text,
	`function_tag` text,
	`function_tag_version` text,
	`department` text,
	`aliases` text NOT NULL,
	`raw` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_canonical_key_unique` ON `postings` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `postings_source_id_last_seen_at_idx` ON `postings` (`source_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `postings_live_idx` ON `postings` (`delisted_at`) WHERE "postings"."delisted_at" is null;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posting_id` text REFERENCES postings(id) ON DELETE set null;