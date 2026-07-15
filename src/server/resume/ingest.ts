// F1 ingest orchestration — the only module besides route.ts's thin
// boundary that touches DB (resumesRepo) or LLM (getLlm). Never persists a
// partial résumé: view-derivability is asserted before any side effect
// (file write / DB insert).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { rasterizePdfPages } from "@/lib/rasterize";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import type { Resume } from "@/types";
import { assertResumeViewDerivable, ParseFailedError, toResumeView } from "./derive-view";
import { computeAtsScore } from "./atsScore";
import { extractText } from "./extract-text";
import { assertEnglish } from "./language";
import { resolveUpload, resumeKey } from "./uploads";
import { ResumeStoreEmitSchema, emitToStore, type ResumeStore } from "./resume-store";

const PDF_MIME = "application/pdf";

// Below this many extracted chars, a PDF's text layer is too sparse to
// structure reliably (image-only, or a hybrid text-headings+image-body
// résumé yielding junk fragments) — route to vision instead of the text
// path. Matches the design's 2-page vision cap below.
const VISION_TEXT_THRESHOLD = 400;
const VISION_MAX_PAGES = 2;

// Vision-path English gate runs on the STRUCTURED result, not `rawText`
// (which is near-empty for an image-only PDF and carries no language
// signal) — concatenates the store's own text fields for assertEnglish.
function concatStoreText(store: ResumeStore): string {
  return [
    store.name,
    store.headline,
    store.location,
    store.summary,
    ...store.experience.flatMap((e) => [e.title, e.company, ...e.bullets]),
    ...store.education.flatMap((e) => [e.school, e.credential, ...e.details]),
    ...store.skills.flatMap((g) => g.items),
    ...store.projects.flatMap((p) => [p.name, ...p.bullets]),
    ...store.sections.flatMap((s) => [s.heading, ...s.items]),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

const OPTIONAL_SCALAR_FIELDS = ["headline", "location", "summary"] as const;

// One structured log line per extraction — the drift radar + concept-
// promotion signal. absentOptionalFields flags a template regression before
// it silently starts dropping a field; sections lists the "other section"
// headings the LLM captured outside the known concepts (a heading recurring
// across extractions is a candidate to promote to a first-class field);
// dateMissCount counts experience entries where coerceMonth (resume-store.ts)
// couldn't parse either atom from a non-empty `dates` string. Education has
// no start/end atoms to inspect, so it never contributes a miss.
function buildExtractionTelemetry(store: ResumeStore) {
  return {
    extractionPath: store.extractionPath,
    absentOptionalFields: OPTIONAL_SCALAR_FIELDS.filter((field) => store[field] === undefined),
    sections: store.sections.map((s) => s.heading),
    dateMissCount: store.experience.filter(
      (e) => e.dates.trim().length > 0 && e.start === undefined && e.end === undefined,
    ).length,
  };
}

// Wraps LLM client construction + the completion call so a construction
// failure (e.g. a missing OPENROUTER_API_KEY) or a completion failure both
// map to ParseFailedError → 502, like any other LLM failure, instead of
// propagating as an unmapped bare 500.
async function completeOrThrow<T>(
  llmOverride: LlmClient | undefined,
  fn: (llm: LlmClient) => Promise<T>,
): Promise<T> {
  try {
    return await fn(llmOverride ?? getLlm());
  } catch (err) {
    throw new ParseFailedError(`Résumé structuring failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface IngestResumeInput {
  file?: { bytes: Buffer; mime: string; filename?: string };
  text?: string;
}

export interface IngestResumeDeps {
  llm?: LlmClient;
}

function rowToResumeView(row: ResumeRow): Resume {
  const atsScore = row.atsScore;
  if (atsScore === null) {
    throw new Error("resumes.atsScore is null — every row inserted by ingestResume sets it explicitly");
  }
  return toResumeView(row.structured, {
    id: row.id,
    atsScore,
    updatedAt: row.updatedAt.toISOString(),
    rawText: row.rawText,
  });
}

export async function ingestResume(
  userId: string,
  input: IngestResumeInput,
  deps: IngestResumeDeps = {},
): Promise<Resume> {
  const rawText = await extractText(input);

  const isVisionCandidate =
    input.file?.mime === PDF_MIME && rawText.trim().length < VISION_TEXT_THRESHOLD;

  let structured: ResumeStore;
  if (isVisionCandidate) {
    const result = await completeOrThrow(deps.llm, async (llm) => {
      const images = await rasterizePdfPages(input.file!.bytes, VISION_MAX_PAGES);
      return llm.complete({
        task: "resume-extract-vision",
        messages: renderTemplate("resume-extract-vision", {}),
        responseSchema: ResumeStoreEmitSchema,
        images,
      });
    });
    structured = emitToStore(result.data, "vision");
    // English-first MVP: reject non-English résumés loudly. The vision path
    // has no usable rawText to check, so this runs on the structured result
    // instead — after the LLM call, not before.
    assertEnglish(concatStoreText(structured));
  } else {
    // English-first MVP: reject non-English résumés loudly, before the LLM
    // call, rather than mis-structuring text the extraction model (and
    // pdf.js CJK handling) was never validated against.
    assertEnglish(rawText);
    const result = await completeOrThrow(deps.llm, (llm) =>
      llm.complete({
        task: "resume-extract",
        messages: renderTemplate("resume-extract", { rawText }),
        responseSchema: ResumeStoreEmitSchema,
      }),
    );
    structured = emitToStore(result.data, "text");
  }

  console.log("resume ingest: extraction telemetry", buildExtractionTelemetry(structured));

  // Fail loud before any side effect: a résumé the LLM structured
  // "successfully" but that yields no derivable location/headline must
  // never be persisted.
  assertResumeViewDerivable(structured);

  const atsScore = computeAtsScore(structured);

  let originalPath: string | null = null;
  let sourceKind: "pdf" | "docx" | "paste" = "paste";
  if (input.file) {
    sourceKind = input.file.mime === PDF_MIME ? "pdf" : "docx";
    const hash = createHash("sha256").update(input.file.bytes).digest("hex");
    const key = resumeKey(userId, hash, sourceKind);
    const abs = resolveUpload(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.file.bytes);
    originalPath = key;
  }

  const inserted = await resumesRepo.insertReplacingActive({
    userId,
    rawText,
    structured,
    originalPath,
    sourceKind,
    atsScore,
    isActive: true,
  });

  return rowToResumeView(inserted);
}

export async function getActiveResume(userId: string): Promise<Resume | null> {
  const row = await resumesRepo.getActive(userId);
  if (!row) return null;
  return rowToResumeView(row);
}
