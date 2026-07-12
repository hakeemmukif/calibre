ALTER TABLE "jobs" ADD COLUMN "eligibility" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "eligibility_evidence" text NOT NULL DEFAULT 'predates eligibility classification';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "eligibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "eligibility_evidence" DROP DEFAULT;
