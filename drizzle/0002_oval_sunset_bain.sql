ALTER TABLE "tailored_resumes" ALTER COLUMN "model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tailored_resumes" ADD COLUMN "completed_at" timestamp;