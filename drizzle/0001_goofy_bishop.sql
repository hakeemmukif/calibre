CREATE INDEX `job_scores_created_at_idx` ON `job_scores` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_user_id_first_seen_at_idx` ON `jobs` (`user_id`,`first_seen_at`);--> statement-breakpoint
CREATE INDEX `url_checks_running_idx` ON `url_checks` (`status`,`lease_expires_at`) WHERE "url_checks"."status" = 'running';