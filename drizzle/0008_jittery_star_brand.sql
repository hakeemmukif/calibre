ALTER TABLE "profile" ADD COLUMN "schedule_flex" text NOT NULL DEFAULT 'any-hours';--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "employment_pref" text NOT NULL DEFAULT 'any';--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "schedule_flex" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "employment_pref" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "tz_band" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hiring_structure" text;
