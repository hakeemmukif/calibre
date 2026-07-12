CREATE TABLE "url_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"stage" text,
	"job_id" uuid,
	"already_known" boolean NOT NULL,
	"needs_text" boolean NOT NULL,
	"error" jsonb,
	"cost_usd" numeric(8, 4) NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "url_checks" ADD CONSTRAINT "url_checks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;