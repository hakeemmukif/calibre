import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { RESUME_STORE, RESUME_STORE_VISION } from "@/lib/llm/scripted-fixtures";
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import { ParseFailedError } from "./derive-view";
import { getActiveResume, ingestResume } from "./ingest";
import { NonEnglishResumeError } from "./language";

const FIXTURES = join(__dirname, "__fixtures__");

const state = vi.hoisted(() => ({ insertReplacingActive: vi.fn(), getActive: vi.fn(), rasterizePdfPages: vi.fn() }));
vi.mock("@/server/persistence/repos/resumes", () => ({
  resumesRepo: { insertReplacingActive: state.insertReplacingActive, getActive: state.getActive },
}));
vi.mock("@/lib/rasterize", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rasterize")>("@/lib/rasterize");
  state.rasterizePdfPages.mockImplementation(actual.rasterizePdfPages);
  return { ...actual, rasterizePdfPages: state.rasterizePdfPages };
});

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

describe("rowToResumeView — v1-row read-boundary guard", () => {
  beforeEach(() => {
    state.getActive.mockReset();
  });

  it("throws an actionable reextract error for a stored row that predates v2 (storeVersion=1)", async () => {
    state.getActive.mockResolvedValueOnce(fakeRow({ storeVersion: 1 }));
    await expect(getActiveResume("user-1")).rejects.toThrow(/reextract/);
  });

  it("throws the same actionable error when storeVersion is absent entirely", async () => {
    state.getActive.mockResolvedValueOnce(fakeRow({}));
    await expect(getActiveResume("user-1")).rejects.toThrow(/reextract/);
  });
});

describe("ingestResume — text-path minimum-text floor", () => {
  it("throws ParseFailedError before any LLM call for near-empty extracted text", async () => {
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;

    await expect(ingestResume("user-1", { text: "Too short" }, { llm })).rejects.toThrow(ParseFailedError);
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

  it("maps a rasterization failure to ParseFailedError instead of the raw error", async () => {
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;
    state.rasterizePdfPages.mockRejectedValueOnce(new Error("@napi-rs/canvas is not available"));

    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    await expect(
      ingestResume("user-1", { file: { bytes, mime: "application/pdf" } }, { llm }),
    ).rejects.toThrow(ParseFailedError);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("ingestResume — extraction telemetry", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.insertReplacingActive.mockReset();
    state.insertReplacingActive.mockImplementation(async (row: { structured: unknown }) =>
      fakeRow(row.structured),
    );
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function llmFor(task: string, data: unknown): LlmClient {
    const complete = vi.fn(async ({ task: gotTask }: { task: string }) => {
      if (gotTask !== task) throw new Error(`unexpected task "${gotTask}"`);
      return { data, model: "mock", costUsd: 0 };
    });
    return { complete } as unknown as LlmClient;
  }

  const ALL_PRESENT_EMIT = {
    storeVersion: 2,
    name: "Jane Doe",
    headline: "Senior Backend Engineer",
    location: "Kuala Lumpur, Malaysia",
    summary: "Backend engineer with experience in backend systems.",
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: "2022–Present",
        start: "2022-01",
        end: null,
        location: null,
        bullets: ["Led migration to Kubernetes"],
      },
    ],
    education: [],
    skills: [{ label: "Domain", items: ["Payments"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [
      { heading: "Volunteer Work", items: ["Habitat for Humanity"] },
      { heading: "Awards", items: ["Employee of the year"] },
    ],
  };

  const ABSENT_SCALARS_EMIT = {
    storeVersion: 2,
    name: "Jane Doe",
    headline: null,
    location: null,
    summary: null,
    contact: [{ label: "location", value: "Kuala Lumpur, Malaysia" }],
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: "2022–Present",
        start: "2022-01",
        end: null,
        location: null,
        bullets: ["Led migration to Kubernetes"],
      },
    ],
    education: [],
    skills: [{ label: "Domain", items: ["Payments"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
  };

  const DATE_MISS_EMIT = {
    storeVersion: 2,
    name: "Jane Doe",
    headline: "Senior Backend Engineer",
    location: "Kuala Lumpur, Malaysia",
    summary: "Backend engineer with experience in backend systems.",
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: "2022–Present",
        start: "2022-01",
        end: null,
        location: null,
        bullets: ["Led migration to Kubernetes"],
      },
      {
        company: "Beta Inc",
        title: "Backend Engineer",
        dates: "Summer 2019",
        start: null,
        end: null,
        location: null,
        bullets: ["Built API"],
      },
    ],
    education: [],
    skills: [{ label: "Domain", items: ["Payments"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
  };

  const EMPTY_DATES_EMIT = {
    storeVersion: 2,
    name: "Jane Doe",
    headline: "Senior Backend Engineer",
    location: "Kuala Lumpur, Malaysia",
    summary: "Backend engineer with experience in backend systems.",
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: null,
        start: null,
        end: null,
        location: null,
        bullets: ["Led migration to Kubernetes"],
      },
    ],
    education: [],
    skills: [{ label: "Domain", items: ["Payments"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
  };

  function telemetryFromSpy(): Record<string, unknown> {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [prefix, telemetry] = logSpy.mock.calls[0];
    expect(prefix).toBe("resume ingest: extraction telemetry");
    return telemetry as Record<string, unknown>;
  }

  it("logs one telemetry line for the text path with an empty absent-list, section headings, and zero date-misses", async () => {
    const llm = llmFor("resume-extract", ALL_PRESENT_EMIT);
    await ingestResume(
      "user-1",
      { text: "Backend engineer with experience in systems design, distributed systems, and payments infrastructure across several years of professional software engineering work." },
      { llm },
    );

    const telemetry = telemetryFromSpy();
    expect(telemetry).toMatchObject({
      extractionPath: "text",
      absentOptionalFields: [],
      sections: ["Volunteer Work", "Awards"],
      dateMissCount: 0,
      emptyDatesCount: 0,
    });
  });

  it("lists absent optional scalar fields when headline/location/summary come back null", async () => {
    const llm = llmFor("resume-extract", ABSENT_SCALARS_EMIT);
    await ingestResume(
      "user-1",
      { text: "Backend engineer with experience in systems design, distributed systems, and payments infrastructure across several years of professional software engineering work." },
      { llm },
    );

    const telemetry = telemetryFromSpy();
    expect(telemetry).toMatchObject({
      extractionPath: "text",
      absentOptionalFields: ["headline", "location", "summary"],
    });
  });

  it("counts a date-miss when an experience entry has a non-empty dates string but no parsed start/end atom", async () => {
    const llm = llmFor("resume-extract", DATE_MISS_EMIT);
    await ingestResume(
      "user-1",
      { text: "Backend engineer with experience in systems design, distributed systems, and payments infrastructure across several years of professional software engineering work." },
      { llm },
    );

    const telemetry = telemetryFromSpy();
    expect(telemetry).toMatchObject({ dateMissCount: 1 });
  });

  it("counts an empty-dates entry (verbatim date range absent, folded to \"\") separately from a date-miss", async () => {
    const llm = llmFor("resume-extract", EMPTY_DATES_EMIT);
    await ingestResume(
      "user-1",
      { text: "Backend engineer with experience in systems design, distributed systems, and payments infrastructure across several years of professional software engineering work." },
      { llm },
    );

    const telemetry = telemetryFromSpy();
    expect(telemetry).toMatchObject({ dateMissCount: 0, emptyDatesCount: 1 });
  });

  it("logs extractionPath: \"vision\" exactly once for the vision routing path", async () => {
    const llm = llmFor("resume-extract-vision", RESUME_STORE_VISION);
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    await ingestResume("user-1", { file: { bytes, mime: "application/pdf" } }, { llm });

    const telemetry = telemetryFromSpy();
    expect(telemetry).toMatchObject({ extractionPath: "vision" });
  });
});
