// F4 tier dispatch (task-B7-brief.md "locked interfaces" + system-architecture.md
// §5 "F4 — getting external form questions"). Priority: pastedForm -> tier 3
// (paste, the universal guarantee) is checked FIRST since it needs neither a
// job row nor a live fetch; jobId/url -> tier 1 (Greenhouse structured API,
// jobId only) then tier 2 (headless DOM parse, any URL). NEVER returns `[]`
// as a guess — every branch that yields no questions throws
// ExtractionFailedError instead.
import { z } from "zod";
import { getLlm } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { assembleJob } from "@/features/feed/assemble";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { connectorForSource } from "@/server/search/connectors";
import { resolveIsNewCutoff } from "@/server/search/jobsFeed";
import { ApplicationQuestion } from "@/types";
import { mapFields } from "./map-fields";
import { parseFormViaDom } from "./dom-parse";

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`No job with id "${jobId}".`);
    this.name = "UnknownJobError";
  }
}

export class ExtractionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailedError";
  }
}

const PasteExtractResponse = z.object({ questions: z.array(ApplicationQuestion) });

async function tier3Paste(pastedForm: string): Promise<ApplicationQuestion[]> {
  const llm = getLlm();
  let result: { data: z.infer<typeof PasteExtractResponse>; model: string; costUsd: number };
  try {
    result = await llm.complete({
      task: "question-extract",
      messages: renderTemplate("question-extract", { formText: pastedForm }),
      responseSchema: PasteExtractResponse,
    });
  } catch (err) {
    // A malformed model reply (schema-invalid JSON, ignored json_schema, ...)
    // is an UPSTREAM failure, not a bad request — must land as 502
    // EXTRACTION_FAILED, never the bare ZodError the route would otherwise
    // catch as 422 VALIDATION_ERROR (fix pass finding 1).
    throw new ExtractionFailedError(`Paste parsing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.data.questions;
}

export async function extractQuestions(
  userId: string,
  input: { jobId?: string; url?: string; pastedForm?: string },
): Promise<{ questions: ApplicationQuestion[]; sourceUrl: string | null }> {
  if (input.pastedForm !== undefined) {
    const questions = await tier3Paste(input.pastedForm);
    if (questions.length === 0) {
      throw new ExtractionFailedError("Paste parsing found no questions in the supplied form text.");
    }
    return { questions, sourceUrl: null };
  }

  let sourceUrl: string;
  let tier1Fields: Awaited<ReturnType<NonNullable<ReturnType<typeof connectorForSource>["extractQuestions"]>>> | null = null;

  if (input.jobId !== undefined) {
    const joined = await jobsRepo.getById(input.jobId, userId);
    if (!joined) throw new UnknownJobError(input.jobId);

    const cutoff = await resolveIsNewCutoff(userId, joined.job.persona);
    const job = assembleJob(joined, { isNewCutoff: cutoff });
    sourceUrl = job.applyUrl;

    const connector = connectorForSource(joined.source);
    tier1Fields = connector.extractQuestions ? await connector.extractQuestions(job) : null;
    if (tier1Fields && tier1Fields.length > 0) {
      try {
        return { questions: mapFields(tier1Fields), sourceUrl };
      } catch {
        // A mapping failure (unrecognized field_type, or an unparseable
        // limit -> ApplicationQuestion.parse throw) on tier 1 is NOT a
        // reason to 500 — fall through to tier 2 same as an empty tier-1
        // result (fix pass finding 2). Falls into the tier-2 code below.
      }
    }
  } else if (input.url !== undefined) {
    sourceUrl = input.url;
  } else {
    // Defensive only — the route's `.refine` already enforces exactly one of
    // jobId/url/pastedForm before this is called.
    throw new Error("extractQuestions requires exactly one of jobId, url, or pastedForm.");
  }

  const tier2Fields = await parseFormViaDom(sourceUrl);
  if (tier2Fields && tier2Fields.length > 0) {
    try {
      return { questions: mapFields(tier2Fields), sourceUrl };
    } catch (err) {
      // Same mapping-failure class as tier 1, but there's no further tier to
      // fall through to — must still land as 502 EXTRACTION_FAILED, never a
      // bare 500 (fix pass finding 2).
      throw new ExtractionFailedError(
        `Could not map extracted form fields for "${sourceUrl}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new ExtractionFailedError(
    `Could not extract application questions for "${sourceUrl}" — no structured ATS API matched and DOM parsing found no form.`,
  );
}
