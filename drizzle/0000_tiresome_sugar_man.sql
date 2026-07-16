CREATE TABLE `application_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`form_source` text NOT NULL,
	`answers` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`tailored_resume_id` text,
	`answers_id` text,
	`stage` integer NOT NULL,
	`status_label` text NOT NULL,
	`status_tone` text NOT NULL,
	`note` text NOT NULL,
	`applied_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tailored_resume_id`) REFERENCES `tailored_resumes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answers_id`) REFERENCES `application_answers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_id_unique` ON `applications` (`job_id`);--> statement-breakpoint
CREATE TABLE `correlation_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`rows` text NOT NULL,
	`semantic` text,
	`ats` text,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`score` real NOT NULL,
	`verdict` text NOT NULL,
	`why` text NOT NULL,
	`legitimacy` text NOT NULL,
	`liveness` text NOT NULL,
	`breakdown` text NOT NULL,
	`reasons` text NOT NULL,
	`fit` text NOT NULL,
	`gaps` text NOT NULL,
	`jd_facts` text NOT NULL,
	`model` text NOT NULL,
	`escalated` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`policy_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_scores_job_resume_policy_unique` ON `job_scores` (`job_id`,`resume_id`,`policy_version`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
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
	`persona` text NOT NULL,
	`eligibility` text NOT NULL,
	`eligibility_evidence` text NOT NULL,
	`aliases` text NOT NULL,
	`raw` text NOT NULL,
	`tz_band` text,
	`hiring_structure` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_id_dedupe_key_unique` ON `jobs` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`base_country` text NOT NULL,
	`relocation` text NOT NULL,
	`schedule_flex` text NOT NULL,
	`employment_pref` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_user_id_unique` ON `profile` (`user_id`);--> statement-breakpoint
CREATE TABLE `resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`structured` text NOT NULL,
	`original_path` text,
	`label` text,
	`source_kind` text NOT NULL,
	`ats_score` real,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resumes_user_id_active_unique` ON `resumes` (`user_id`) WHERE "resumes"."is_active";--> statement-breakpoint
CREATE TABLE `search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`personas` text NOT NULL,
	`status` text NOT NULL,
	`stats` text NOT NULL,
	`results` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`persona` text NOT NULL,
	`enabled` integer NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tailored_resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`base_resume_id` text NOT NULL,
	`report_id` text,
	`structured` text,
	`diff` text NOT NULL,
	`html` text,
	`pdf_path` text,
	`status` text NOT NULL,
	`finalized_at` integer,
	`accepted_indices` text,
	`ats_delta` text,
	`model` text NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `correlation_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `url_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text NOT NULL,
	`stage` text,
	`job_id` text,
	`already_known` integer NOT NULL,
	`needs_text` integer NOT NULL,
	`error` text,
	`cost_usd` real NOT NULL,
	`raw` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `url_checks_queued_idx` ON `url_checks` (`status`,`created_at`) WHERE "url_checks"."status" = 'queued';--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
INSERT INTO `users` (`id`,`email`,`password_hash`,`role`,`created_at`) VALUES ('00000000-0000-4000-8000-000000000001','admin@bootstrap.local','!','admin', unixepoch() * 1000) ON CONFLICT (`id`) DO NOTHING;