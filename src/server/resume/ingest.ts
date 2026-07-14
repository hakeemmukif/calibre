// F1 ingest orchestration — the only module besides route.ts's thin
// boundary that touches DB (resumesRepo) or LLM (getLlm). Never persists a
// partial résumé: view-derivability is asserted before any side effect
// (file write / DB insert).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import type { Resume } from "@/types";
import { assertResumeViewDerivable, ParseFailedError, toResumeView } from "./derive-view";
import { computeAtsScore } from "./atsScore";
import { extractText } from "./extract-text";
import { resolveUpload, resumeKey } from "./uploads";
import { ResumeStoreEmitSchema, emitToStore, type ResumeStore } from "./resume-store";

const PDF_MIME = "application/pdf";

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

  // getLlm() is inside the try so a client-construction failure (e.g. a
  // missing OPENROUTER_API_KEY) is mapped to ParseFailedError → 502 like any
  // other LLM failure, instead of propagating as an unmapped bare 500.
  let structured: ResumeStore;
  try {
    const llm = deps.llm ?? getLlm();
    const result = await llm.complete({
      task: "resume-extract",
      messages: renderTemplate("resume-extract", { rawText }),
      responseSchema: ResumeStoreEmitSchema,
    });
    structured = emitToStore(result.data, "text");
  } catch (err) {
    throw new ParseFailedError(`Résumé structuring failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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
