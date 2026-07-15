ALTER TABLE "resumes" ADD COLUMN "label" text;--> statement-breakpoint
UPDATE "resumes" SET "label" = COALESCE(
  NULLIF(regexp_replace("original_path", '^.*/', ''), ''),  -- basename of the uploaded file
  "structured" ->> 'headline',                               -- pasted résumés: the parsed headline
  'Résumé ' || substr("id"::text, 1, 8)                      -- last-resort stable label
) WHERE "label" IS NULL;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "results" jsonb DEFAULT '[]'::jsonb NOT NULL;