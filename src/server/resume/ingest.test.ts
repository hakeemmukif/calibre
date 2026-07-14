import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { RESUME_STORE, RESUME_STORE_VISION } from "@/lib/llm/scripted-fixtures";
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import { ingestResume } from "./ingest";
import { NonEnglishResumeError } from "./language";

const FIXTURES = join(__dirname, "__fixtures__");

const state = vi.hoisted(() => ({ insertReplacingActive: vi.fn() }));
vi.mock("@/server/persistence/repos/resumes", () => ({
  resumesRepo: { insertReplacingActive: state.insertReplacingActive },
}));

function fakeRow(structured: unknown): ResumeRow {
  return {
    id: "resume-1",
    userId: "user-1",
    rawText: "raw text",
    structured,
    originalPath: null,
    sourceKind: "pdf",
    atsScore: 50,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ResumeRow;
}

const BAHASA_MALAYSIA_RESUME = `
Saya bekerja sebagai jurutera perisian di sebuah syarikat teknologi selama lima tahun.
Saya mempunyai kemahiran dalam pengekodan, reka bentuk sistem, serta kerja berpasukan.
Saya juga pernah mengetuai projek pembangunan aplikasi mudah alih untuk pelanggan korporat
serta menyelaraskan keperluan perniagaan dengan pasukan pembangunan yang lain.
`;

describe("ingestResume — English-first reject gate", () => {
  it("rejects a non-English pasted résumé before any LLM call", async () => {
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;

    await expect(ingestResume("user-1", { text: BAHASA_MALAYSIA_RESUME }, { llm })).rejects.toThrow(
      NonEnglishResumeError,
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("ingestResume — vision routing for image-only/near-textless PDFs", () => {
  let uploadsDir: string;

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), "caliber-ingest-test-"));
    process.env.CALIBER_UPLOADS_DIR = uploadsDir;
    state.insertReplacingActive.mockReset();
  });

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true });
  });

  it("routes a PDF with < 400 chars of extracted text to resume-extract-vision and persists extractionPath: \"vision\"", async () => {
    state.insertReplacingActive.mockImplementation(async (row: { structured: unknown }) =>
      fakeRow(row.structured),
    );
    const complete = vi.fn(async ({ task }: { task: string }) => {
      if (task !== "resume-extract-vision") throw new Error(`unexpected task "${task}"`);
      return { data: RESUME_STORE_VISION, model: "mock", costUsd: 0 };
    });
    const llm = { complete } as unknown as LlmClient;

    // tiny.pdf's real text layer is ~153 chars — well under the 400-char
    // vision-routing threshold.
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    await ingestResume("user-1", { file: { bytes, mime: "application/pdf" } }, { llm });

    expect(complete).toHaveBeenCalledTimes(1);
    const callArgs = complete.mock.calls[0][0] as { task: string; images?: string[] };
    expect(callArgs.task).toBe("resume-extract-vision");
    expect(callArgs.images).toBeDefined();
    expect(callArgs.images!.length).toBeGreaterThanOrEqual(1);

    expect(state.insertReplacingActive).toHaveBeenCalledTimes(1);
    const persisted = state.insertReplacingActive.mock.calls[0][0] as { structured: { extractionPath: string } };
    expect(persisted.structured.extractionPath).toBe("vision");
  });

  it("still uses resume-extract for a normal text PDF (>= 400 chars extracted)", async () => {
    state.insertReplacingActive.mockImplementation(async (row: { structured: unknown }) =>
      fakeRow(row.structured),
    );
    const complete = vi.fn(async ({ task }: { task: string }) => {
      if (task !== "resume-extract") throw new Error(`unexpected task "${task}"`);
      return { data: RESUME_STORE, model: "mock", costUsd: 0 };
    });
    const llm = { complete } as unknown as LlmClient;

    // long-text.pdf's real text layer is ~520 chars — above the 400-char
    // vision-routing threshold.
    const bytes = readFileSync(join(FIXTURES, "long-text.pdf"));
    await ingestResume("user-1", { file: { bytes, mime: "application/pdf" } }, { llm });

    expect(complete).toHaveBeenCalledTimes(1);
    const callArgs = complete.mock.calls[0][0] as { task: string; images?: string[] };
    expect(callArgs.task).toBe("resume-extract");
    expect(callArgs.images).toBeUndefined();

    expect(state.insertReplacingActive).toHaveBeenCalledTimes(1);
    const persisted = state.insertReplacingActive.mock.calls[0][0] as { structured: { extractionPath: string } };
    expect(persisted.structured.extractionPath).toBe("text");
  });
});
