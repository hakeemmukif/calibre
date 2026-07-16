// One-time ops script (CLI, module-main guard mirrors migrate-uploads.ts):
// upgrades v1 `resumes.structured` rows to the v2 store shape by
// RE-EXTRACTING from the stored `rawText` — not an SQL heading-fold —
// mirroring ingest.ts's TEXT path exactly (resume-extract task ->
// emitToStore -> assertResumeViewDerivable -> computeAtsScore) so a
// migrated row is indistinguishable from a fresh text-path ingest.
// `tailored_resumes` is READ-ONLY here — counted for operator visibility
// only (they have no rawText and are regenerable), never re-extracted or
// rewritten. Idempotent (storeVersion===2 rows are skipped) and per-row
// tolerant (one row's LLM/parse failure never aborts the run or corrupts
// that row).
//
// Run with DATABASE_URL set inline — dev-DB drift: `.env.local` is absent,
// `next dev` loads `.env`, so a bare `npx tsx` may target the wrong DB:
//   DATABASE_URL=file:./caliber.db npx tsx src/server/resume/reextract.ts
// The OPERATOR runs the live migration — do not run this against real data.
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import type { Db } from "../persistence/repos/db";
import { resumes, tailoredResumes } from "../persistence/schema";
import { getDb } from "../persistence/db";
import { assertResumeViewDerivable } from "./derive-view";
import { computeAtsScore } from "./atsScore";
import { ResumeStoreEmitSchema, emitToStore } from "./resume-store";

// Matches ingest.ts's VISION_TEXT_THRESHOLD: below this many chars, rawText
// carries no usable signal to re-extract from (vision-origin row) — v1
// predates vision so this should be rare, but guard it rather than
// mis-structure noise into a bogus v2 row.
const MIN_USABLE_TEXT_LENGTH = 400;

export interface ReextractResult {
  migrated: number;
  skipped: number;
  failed: number;
  tailoredV1Left: number;
}

export async function reextractResumes(db: Db, llm: LlmClient): Promise<ReextractResult> {
  const rows = await db.select().from(resumes);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.structured?.storeVersion === 2) {
      skipped++;
      continue;
    }

    if (row.rawText.trim().length < MIN_USABLE_TEXT_LENGTH) {
      console.warn(
        `reextract: row ${row.id} — rawText too sparse (${row.rawText.trim().length} chars) to re-extract from text, skipping`,
      );
      skipped++;
      continue;
    }

    try {
      const result = await llm.complete({
        task: "resume-extract",
        messages: renderTemplate("resume-extract", { rawText: row.rawText }),
        responseSchema: ResumeStoreEmitSchema,
      });
      const structured = emitToStore(result.data, "text");
      assertResumeViewDerivable(structured);
      const atsScore = computeAtsScore(structured);

      await db.update(resumes).set({ structured, atsScore }).where(eq(resumes.id, row.id));
      migrated++;
    } catch (err) {
      console.warn(`reextract: row ${row.id} — re-extraction failed, skipping: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  const tailoredRows = await db.select().from(tailoredResumes);
  const tailoredV1Left = tailoredRows.filter((r) => r.structured?.storeVersion !== 2).length;

  return { migrated, skipped, failed, tailoredV1Left };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  const llm = getLlm();
  reextractResumes(db, llm)
    .then(({ migrated, skipped, failed, tailoredV1Left }) => {
      console.log(
        `reextract: migrated ${migrated} row(s), skipped ${skipped}, failed ${failed}; tailored_resumes rows still v1: ${tailoredV1Left}`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
