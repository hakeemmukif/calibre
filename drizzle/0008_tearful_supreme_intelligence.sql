ALTER TABLE "profile" ADD COLUMN "schedule_flex" text DEFAULT 'any-hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "employment_pref" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "schedule_flex" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "employment_pref" DROP DEFAULT;
