import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { RESUME_STORE } from "@/lib/llm/scripted-fixtures";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { jobs, resumes, sources, tailoredResumes } from "@/server/persistence/schema";
import type { ResumeStore } from "./resume-store";
import { reextractResumes } from "./reextract";

// v1 rows predate storeVersion — cast past the ResumeStore type (jsonb has no
// runtime enforcement) to fixture the pre-migration shape a real v1 row held.
const v1Structured = { name: "Old Shape", raw: "some prior heading-fold" } as unknown as ResumeStore;

const V1_RAW_TEXT = `
Jane Doe
Senior Backend Engineer

Summary
Backend engineer with six years of experience building payments systems.

Experience
Acme Co — Senior Backend Engineer (2022–Present)
Led migration to Kubernetes

Skills
Payments, TypeScript
`.repeat(3); // pad past MIN_USABLE_TEXT_LENGTH (400 chars)

async function insertResumeRow(db: TestDb, overrides: Partial<typeof resumes.$inferInsert> = {}) {
  const [row] = await db
    .insert(resumes)
    .values({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: V1_RAW_TEXT,
      structured: v1Structured,
      sourceKind: "paste",
      isActive: false,
      ...overrides,
    })
    .returning();
  return row;
}

function mockLlm(fn: (rawText: string) => Promise<{ data: unknown; model: string; costUsd: number }>): LlmClient {
  const complete = vi.fn(async (args: { task: string; messages: { role: string; content: string }[] }) => {
    if (args.task !== "resume-extract") throw new Error(`unexpected task "${args.task}"`);
    const candidate = args.messages[args.messages.length - 1].content;
    return fn(candidate);
  });
  return { complete } as unknown as LlmClient;
}

describe("reextractResumes", () => {
  it("re-extracts a v1 (storeVersion !== 2) row to v2 and writes back structured + atsScore", async () => {
    const db = await createTestDb();
    const row = await insertResumeRow(db);
    const llm = mockLlm(async () => ({ data: RESUME_STORE, model: "mock", costUsd: 0 }));

    const result = await reextractResumes(db, llm);
    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0, tailoredV1Left: 0 });

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.structured.storeVersion).toBe(2);
    expect(after.structured.name).toBe("Jane Doe");
    expect(after.atsScore).not.toBeNull();
  });

  it("skips a row already at storeVersion === 2, leaving it unchanged", async () => {
    const db = await createTestDb();
    const v2Structured: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "Already V2",
      contact: [],
      summary: "s",
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    const row = await insertResumeRow(db, { structured: v2Structured, atsScore: 42 });
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;

    const result = await reextractResumes(db, llm);
    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0, tailoredV1Left: 0 });
    expect(complete).not.toHaveBeenCalled();

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.structured).toEqual(v2Structured);
    expect(after.atsScore).toBe(42);
  });

  it("is idempotent — running twice migrates 0 the second time", async () => {
    const db = await createTestDb();
    await insertResumeRow(db);
    const llm = mockLlm(async () => ({ data: RESUME_STORE, model: "mock", costUsd: 0 }));

    const first = await reextractResumes(db, llm);
    expect(first.migrated).toBe(1);

    const second = await reextractResumes(db, llm);
    expect(second).toEqual({ migrated: 0, skipped: 1, failed: 0, tailoredV1Left: 0 });
  });

  it("skips a row with too-sparse rawText to re-extract from (vision-origin guard)", async () => {
    const db = await createTestDb();
    const row = await insertResumeRow(db, { rawText: "too short" });
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reextractResumes(db, llm);
    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0, tailoredV1Left: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.structured).toEqual(v1Structured);
    warn.mockRestore();
  });

  it("per-row tolerance: one row's re-extraction throws — counted failed, other rows still migrate, run does not throw, failing row's old structured is intact", async () => {
    const db = await createTestDb();
    const okRow = await insertResumeRow(db, { rawText: `OK_MARKER\n${V1_RAW_TEXT}` });
    const failRow = await insertResumeRow(db, { rawText: `FAIL_MARKER\n${V1_RAW_TEXT}` });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const llm = mockLlm(async (candidate) => {
      if (candidate.includes("FAIL_MARKER")) throw new Error("LLM boom");
      return { data: RESUME_STORE, model: "mock", costUsd: 0 };
    });

    const result = await reextractResumes(db, llm);
    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 1, tailoredV1Left: 0 });

    const [okAfter] = await db.select().from(resumes).where(eq(resumes.id, okRow.id));
    expect(okAfter.structured.storeVersion).toBe(2);

    const [failAfter] = await db.select().from(resumes).where(eq(resumes.id, failRow.id));
    expect(failAfter.structured).toEqual(v1Structured);
    warn.mockRestore();
  });

  it("never writes tailored_resumes — a v1-shaped row is byte-unchanged and counted in tailoredV1Left", async () => {
    const db = await createTestDb();
    const resume = await insertResumeRow(db, { structured: { storeVersion: 2 } as unknown as ResumeStore, isActive: true });
    const [source] = await db
      .insert(sources)
      .values({ id: "reextract-test-source", name: "Test Source", kind: "ats", persona: "remote", enabled: true, config: { geo: { scope: "restricted" } } })
      .returning();
    const [job] = await db
      .insert(jobs)
      .values({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: "reextract-test-job",
        url: "https://example.com/reextract-test-job",
        sourceId: source.id,
        title: "Senior Backend Engineer",
        company: "Example Co",
        location: "Remote",
        persona: "remote",
        eligibility: "unknown",
        eligibilityEvidence: "test fixture",
        aliases: [],
        raw: {},
      })
      .returning();
    const v1TailoredStructured = { name: "V1 tailored shape" } as unknown as ResumeStore;
    const [tailoredRow] = await db
      .insert(tailoredResumes)
      .values({
        userId: BOOTSTRAP_ADMIN_ID,
        jobId: job.id,
        baseResumeId: resume.id,
        structured: v1TailoredStructured,
        diff: [],
        status: "completed",
        model: "test-model",
      })
      .returning();

    const llm = mockLlm(async () => ({ data: RESUME_STORE, model: "mock", costUsd: 0 }));
    const result = await reextractResumes(db, llm);
    expect(result.tailoredV1Left).toBe(1);

    const [tailoredAfter] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.id, tailoredRow.id));
    expect(tailoredAfter).toEqual(tailoredRow);
  });
});
