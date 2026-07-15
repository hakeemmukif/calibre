CREATE TABLE "correlation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"resume_id" uuid NOT NULL,
	"rows" jsonb NOT NULL,
	"semantic" jsonb,
	"ats" jsonb,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(8, 4),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "tailored_resumes" ADD COLUMN "report_id" uuid;--> statement-breakpoint
ALTER TABLE "correlation_reports" ADD CONSTRAINT "correlation_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_reports" ADD CONSTRAINT "correlation_reports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_reports" ADD CONSTRAINT "correlation_reports_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_report_id_correlation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."correlation_reports"("id") ON DELETE no action ON UPDATE no action;