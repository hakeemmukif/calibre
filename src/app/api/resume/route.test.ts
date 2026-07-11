import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { ResumeStore } from "@/server/resume/resume-store";

const UPLOADS_DIR = join(process.cwd(), "data", "uploads");
const PDF_FIXTURE = join(process.cwd(), "src/server/resume/__fixtures__/tiny.pdf");

const state = vi.hoisted(() => ({
  testDb: undefined as unknown as TestDb,
  llm: undefined as unknown as LlmClient,
}));

vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => state.llm };
});

const { GET, POST } = await import("./route");

function structuredFixture(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    name: "Jane Doe",
    contact: [
      { label: "email", value: "jane@example.com" },
      { label: "location", value: "Kuala Lumpur, Malaysia" },
    ],
    summary: "Backend engineer with six years of experience building distributed systems at scale.",
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: "2022–Present",
        bullets: ["Led migration to Kubernetes"],
      },
    ],
    education: [],
    skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
    extras: [],
    ...overrides,
  };
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fileRequest(bytes: Uint8Array, mime: string, filename: string): NextRequest {
  const formData = new FormData();
  formData.set("file", new File([bytes], filename, { type: mime }));
  return new NextRequest("http://localhost/api/resume", { method: "POST", body: formData });
}

describe("/api/resume", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    state.llm = makeMockLlm({ "resume-extract": structuredFixture() });
  });

  afterEach(async () => {
    const { resumes } = await import("@/server/persistence/schema");
    await state.testDb.delete(resumes);
    await rm(UPLOADS_DIR, { recursive: true, force: true });
  });

  it("GET returns 404 when no résumé has been uploaded", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("POST {text} paste happy path persists and returns 200 Resume", async () => {
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(200);
    const resume = await res.json();
    expect(resume.headline).toBe("Senior Backend Engineer");
    expect(resume.location).toBe("Kuala Lumpur, Malaysia");
    expect(resume.skills).toEqual(["TypeScript", "Go"]);

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).id).toBe(resume.id);
  });

  it("a second upload supersedes the first — only one active résumé", async () => {
    const first = await POST(jsonRequest({ text: "a".repeat(120) }));
    const firstResume = await first.json();

    state.llm = makeMockLlm({
      "resume-extract": structuredFixture({ summary: "Second résumé summary, distinct from the first one." }),
    });
    const second = await POST(jsonRequest({ text: "b".repeat(120) }));
    const secondResume = await second.json();

    expect(secondResume.id).not.toBe(firstResume.id);

    const getRes = await GET();
    const active = await getRes.json();
    expect(active.id).toBe(secondResume.id);
    expect(active.summary).toBe("Second résumé summary, distinct from the first one.");
  });

  it("POST {text} shorter than 100 chars returns 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({ text: "too short" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");

    expect((await GET()).status).toBe(404);
  });

  it("POST multipart file over 10MB returns 413 PAYLOAD_TOO_LARGE", async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    const res = await POST(fileRequest(bytes, "application/pdf", "resume.pdf"));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");

    expect((await GET()).status).toBe(404);
  });

  it("POST multipart file with an unsupported mime returns 422 VALIDATION_ERROR", async () => {
    const res = await POST(fileRequest(new Uint8Array([1, 2, 3]), "image/png", "resume.png"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST multipart PDF happy path extracts, persists the original bytes, and returns 200 Resume", async () => {
    const bytes = new Uint8Array(readFileSync(PDF_FIXTURE));
    const res = await POST(fileRequest(bytes, "application/pdf", "resume.pdf"));
    expect(res.status).toBe(200);
    const resume = await res.json();
    expect(resume.headline).toBe("Senior Backend Engineer");
    expect(resume.rawText).toContain("Hello resume world");

    const { resumesRepo } = await import("@/server/persistence/repos/resumes");
    const row = await resumesRepo.getActive();
    expect(row?.sourceKind).toBe("pdf");
    expect(row?.originalPath).toBeTruthy();
    expect(readFileSync(row!.originalPath!)).toEqual(Buffer.from(bytes));
  });

  it("LLM structuring failure returns 502 PARSE_FAILED and persists no row", async () => {
    state.llm = { complete: () => Promise.reject(new Error("upstream exploded")) };
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PARSE_FAILED");

    expect((await GET()).status).toBe(404);
  });

  it("underivable location/headline returns 502 PARSE_FAILED and persists no row", async () => {
    state.llm = makeMockLlm({
      "resume-extract": structuredFixture({ contact: [], experience: [] }),
    });
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PARSE_FAILED");

    expect((await GET()).status).toBe(404);
  });
});
