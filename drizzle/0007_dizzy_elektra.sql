ALTER TABLE "url_checks" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "url_checks" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
CREATE INDEX "url_checks_queued_idx" ON "url_checks" USING btree ("status","created_at") WHERE "url_checks"."status" = 'queued';