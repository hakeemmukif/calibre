ALTER TABLE "job_scores" ADD COLUMN "why" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "sources" SET "name" = "id" WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "name" SET NOT NULL;