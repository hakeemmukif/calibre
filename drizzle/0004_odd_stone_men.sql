ALTER TABLE `profile` ADD `display_location` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `target_role` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `salary_min` integer;--> statement-breakpoint
ALTER TABLE `profile` ADD `salary_max` integer;--> statement-breakpoint
ALTER TABLE `profile` ADD `salary_currency` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `salary_cadence` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `attr_provenance` text DEFAULT '{}' NOT NULL;