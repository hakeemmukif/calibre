CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`feature` text,
	`ref_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_user_id_idx` ON `credit_ledger` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_signup_once` ON `credit_ledger` (`user_id`) WHERE "credit_ledger"."reason" = 'signup';--> statement-breakpoint
ALTER TABLE `users` ADD `plan` text NOT NULL DEFAULT 'standard';--> statement-breakpoint
UPDATE users SET plan = 'unlimited' WHERE role = 'admin';--> statement-breakpoint
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
SELECT lower(hex(randomblob(16))), id, 30, 'signup', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM users WHERE plan = 'standard';