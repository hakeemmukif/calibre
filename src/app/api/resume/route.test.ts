import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";
import { users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { resolveUpload } from "@/server/resume/uploads";
import type { ResumeStoreEmit } from "@/server/resume/resume-store";

const PDF_FIXTURE = join(process.cwd(), "src/server/resume/__fixtures__/tiny.pdf");
const DOCX_FIXTURE = join(process.cwd(), "src/server/resume/__fixtures__/tiny.docx");

const state = vi.hoisted(() => ({
  testDb: undefined as unknown as TestDb,
  llm: undefined as unknown as LlmClient,
  llmError: undefined as Error | undefined,
}));

vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return {
    ...actual,
    getLlm: () => {
      if (state.llmError) throw state.llmError;
      return state.llm;
    },
  };
});

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { GET, POST } = await import("./route");

// Mock "resume-extract" output — ingest.ts now validates this against
// ResumeStoreEmitSchema (every field required, scalars nullable) and runs it
// through emitToStore(), so this fixture is EMIT-shaped, not STORE-shaped.
function structuredFixture(overrides: Partial<ResumeStoreEmit> = {}): ResumeStoreEmit {
  return {
    storeVersion: 2,
    name: "Jane Doe",
    headline: null,
    location: null,
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
        start: null,
        end: null,
        location: null,
        bullets: ["Led migration to Kubernetes"],
      },
    ],
    education: [],
    skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
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
  let tmpUploadsDir: string;

  beforeAll(async () => {
    state.testDb = await createTestDb();
    tmpUploadsDir = await mkdtemp(join(tmpdir(), "caliber-uploads-"));
    process.env.CALIBER_UPLOADS_DIR = tmpUploadsDir;
  });

  afterAll(async () => {
    await rm(tmpUploadsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.llm = makeMockLlm({ "resume-extract": structuredFixture() });
    state.llmError = undefined;
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    const { resumes } = await import("@/server/persistence/schema");
    await state.testDb.delete(resumes);
    await rm(tmpUploadsDir, { recursive: true, force: true });
  });

  it("GET returns 404 when no résumé has been uploaded", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("GET 401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("POST 401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("a second user's active résumé is invisible to the first (cross-tenant isolation)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-resume-route@example.com", passwordHash: "h", role: "user" })
      .returning();

    const uploaded = await POST(jsonRequest({ text: "a".repeat(120) }));
    const resumeA = await uploaded.json();

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    state.llm = makeMockLlm({
      "resume-extract": structuredFixture({ summary: "User B's own résumé summary, distinct from A's." }),
    });
    const uploadedB = await POST(jsonRequest({ text: "b".repeat(120) }));
    const resumeB = await uploadedB.json();
    expect(resumeB.id).not.toBe(resumeA.id);

    const getResB = await GET();
    expect(getResB.status).toBe(200);
    expect((await getResB.json()).id).toBe(resumeB.id);

    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
    const getResA = await GET();
    expect(getResA.status).toBe(200);
    expect((await getResA.json()).id).toBe(resumeA.id); // unaffected by userB's upload
  });

  it("maps an LLM-client construction failure (e.g. missing OPENROUTER_API_KEY) to a 502 PARSE_FAILED envelope, not a bare 500", async () => {
    state.llmError = new Error("OPENROUTER_API_KEY is not set");
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("PARSE_FAILED");
    // must be a real ErrorEnvelope body, never a zero-length response
    expect(body.error.message).toBeTruthy();
  });

  it("POST rejects an over-long paste with 413 PAYLOAD_TOO_LARGE before hitting the LLM", async () => {
    const create = vi.fn();
    state.llm = { complete: create } as unknown as LlmClient;

    const res = await POST(jsonRequest({ text: "a".repeat(12_001) }));

    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(create).not.toHaveBeenCalled();
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

    const { resumesRepo } = await import("@/server/persistence/repos/resumes");
    const row = await resumesRepo.getActive(BOOTSTRAP_ADMIN_ID);
    expect(row?.originalPath).toBeNull();
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

  it("POST {text} in Bahasa Malaysia (non-English) returns 422 VALIDATION_ERROR before hitting the LLM", async () => {
    const create = vi.fn();
    state.llm = { complete: create } as unknown as LlmClient;

    const bahasaMalaysia =
      "Saya bekerja sebagai jurutera perisian di sebuah syarikat teknologi selama lima tahun. " +
      "Saya mempunyai kemahiran dalam pengekodan, reka bentuk sistem, serta kerja berpasukan. " +
      "Saya juga pernah mengetuai projek pembangunan aplikasi mudah alih untuk pelanggan korporat.";
    const res = await POST(jsonRequest({ text: bahasaMalaysia }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(create).not.toHaveBeenCalled();
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
    const row = await resumesRepo.getActive(BOOTSTRAP_ADMIN_ID);
    expect(row?.sourceKind).toBe("pdf");
    expect(row?.originalPath).toBeTruthy();
    expect(row!.originalPath!.startsWith("/")).toBe(false);
    expect(row!.originalPath!.startsWith(`${BOOTSTRAP_ADMIN_ID}/resumes/`)).toBe(true);
    expect(readFileSync(resolveUpload(row!.originalPath!))).toEqual(Buffer.from(bytes));
  });

  it("accepts a DOCX upload through the multipart route (mammoth path)", async () => {
    const bytes = new Uint8Array(readFileSync(DOCX_FIXTURE));
    const res = await POST(
      fileRequest(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "resume.docx"),
    );
    expect(res.status).toBe(200);
    const resume = await res.json();
    expect(resume.headline).toBe("Senior Backend Engineer");
    expect(resume.rawText).toContain("Jane Doe resume docx fixture");

    const { resumesRepo } = await import("@/server/persistence/repos/resumes");
    const row = await resumesRepo.getActive(BOOTSTRAP_ADMIN_ID);
    expect(row?.sourceKind).toBe("docx");
    expect(row?.originalPath).toBeTruthy();
    expect(row!.originalPath!.startsWith("/")).toBe(false);
    expect(readFileSync(resolveUpload(row!.originalPath!))).toEqual(Buffer.from(bytes));
  });

  it("two different users uploading identical bytes get distinct per-user physical files", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-upload@example.com", passwordHash: "h", role: "user" })
      .returning();

    const bytes = new Uint8Array(readFileSync(PDF_FIXTURE));

    const resA = await POST(fileRequest(bytes, "application/pdf", "resume.pdf"));
    expect(resA.status).toBe(200);

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const resB = await POST(fileRequest(bytes, "application/pdf", "resume.pdf"));
    expect(resB.status).toBe(200);

    const { resumesRepo } = await import("@/server/persistence/repos/resumes");
    const rowA = await resumesRepo.getActive(BOOTSTRAP_ADMIN_ID);
    const rowB = await resumesRepo.getActive(userB.id);

    expect(rowA?.originalPath).not.toBe(rowB?.originalPath);
    expect(rowA!.originalPath!.startsWith(`${BOOTSTRAP_ADMIN_ID}/resumes/`)).toBe(true);
    expect(rowB!.originalPath!.startsWith(`${userB.id}/resumes/`)).toBe(true);
    expect(readFileSync(resolveUpload(rowA!.originalPath!))).toEqual(Buffer.from(bytes));
    expect(readFileSync(resolveUpload(rowB!.originalPath!))).toEqual(Buffer.from(bytes));
  });

  it("LLM structuring failure returns 502 PARSE_FAILED and persists no row", async () => {
    state.llm = { complete: () => Promise.reject(new Error("upstream exploded")) };
    const res = await POST(jsonRequest({ text: "a".repeat(120) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PARSE_FAILED");

    expect((await GET()).status).toBe(404);
  });

  it("corrupt PDF bytes (valid mime, invalid content) returns 502 PARSE_FAILED and persists no row", async () => {
    const bytes = new TextEncoder().encode("not a real pdf at all, just garbage bytes that are not valid PDF structure");
    const res = await POST(fileRequest(bytes, "application/pdf", "resume.pdf"));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PARSE_FAILED");

    expect((await GET()).status).toBe(404);
  });

  it("corrupt DOCX bytes (valid mime, invalid content) returns 502 PARSE_FAILED and persists no row", async () => {
    const bytes = new TextEncoder().encode("not a real docx at all, just garbage bytes that are not a valid zip/docx structure");
    const res = await POST(
      fileRequest(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "resume.docx"),
    );
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
