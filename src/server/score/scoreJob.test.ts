import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { EvalScores } from "./evalScores";
import type { JdFacts } from "./jdFacts";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("./liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { scoreJob, EmptyJobDescriptionError } = await import("./index");
const { probeLivenessDeep } = await import("./liveness");

const jdFacts: JdFacts = {
  title: "Backend Engineer",
  mustHaves: ["TypeScript"],
  niceToHaves: [],
  responsibilities: ["Ship features"],
  redFlags: [],
};

const cheapEval: EvalScores = {
  score: 4.2,
  verdict: "Apply",
  why: "Strong TypeScript overlap.",
  breakdown: [{ label: "Skills", value: 4.5 }],
  fit: [{ k: "TypeScript", v: "5 years" }],
  gaps: [{ tone: "ok", k: "Cloud", v: "AWS experience present" }],
  reasons: { for: ["Matches core stack"], against: [] },
  legitimacy: { tier: "clear", summary: "Established company.", signals: [] },
  lowConfidence: false,
};

describe("scoreJob", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    vi.mocked(probeLivenessDeep).mockResolvedValue("active");
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("produces a job_scores row from a cheap, high-confidence result (no escalation)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    const resume = await insertResume(state.testDb);
    const llm = makeMockLlm({ "jd-extract": jdFacts, "match-score": cheapEval });

    const row = await scoreJob({ job, resume, llm });

    expect(row.jobId).toBe(job.id);
    expect(row.resumeId).toBe(resume.id);
    expect(row.score).toBeCloseTo(4.2);
    expect(row.verdict).toBe("Apply");
    expect(row.why).toBe("Strong TypeScript overlap.");
    expect(row.escalated).toBe(false);
    expect(row.liveness).toBe("active");
    expect(row.legitimacy).toEqual({
      tier: "clear",
      tone: "good",
      summary: "Established company.",
      confidence: undefined,
      signals: [],
    });
  });

  it("liveness=expired downgrades an otherwise-clear tier to ghost", async () => {
    vi.mocked(probeLivenessDeep).mockResolvedValue("expired");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role." });
    const resume = await insertResume(state.testDb);
    const llm = makeMockLlm({ "jd-extract": jdFacts, "match-score": cheapEval });

    const row = await scoreJob({ job, resume, llm });
    expect(row.legitimacy.tier).toBe("ghost");
    expect(row.legitimacy.tone).toBe("ghost");
  });

  it("does not escalate a low-confidence cheap result: match-score has no escalateTo configured (donor parity)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role." });
    const resume = await insertResume(state.testDb);

    const llm: LlmClient = {
      async complete(args) {
        if (args.task === "jd-extract") {
          return { data: args.responseSchema.parse(jdFacts), model: "cheap-jd-model", costUsd: 0.001 };
        }
        expect(args.modelOverride).toBeUndefined();
        return {
          data: args.responseSchema.parse({ ...cheapEval, lowConfidence: true }),
          model: "cheap-match-model",
          costUsd: 0.002,
        };
      },
    };

    const row = await scoreJob({ job, resume, llm });

    expect(row.escalated).toBe(false);
    expect(row.model).toBe("cheap-match-model");
    expect(row.costUsd).toBeCloseTo(0.001 + 0.002);
  });

  it("verdict-cache: re-scoring the same (jobId, resumeId, policyVersion) updates the existing row instead of throwing", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role." });
    const resume = await insertResume(state.testDb);
    const llm = makeMockLlm({ "jd-extract": jdFacts, "match-score": cheapEval });

    const first = await scoreJob({ job, resume, llm });

    const updatedEval: EvalScores = { ...cheapEval, score: 2.1, verdict: "Skip" };
    const llm2 = makeMockLlm({ "jd-extract": jdFacts, "match-score": updatedEval });
    const second = await scoreJob({ job, resume, llm: llm2 });

    expect(second.id).toBe(first.id);
    expect(second.score).toBeCloseTo(2.1);
    expect(second.verdict).toBe("Skip");

    const rows = await state.testDb.select().from(jobScores);
    expect(rows.filter((r) => r.jobId === job.id)).toHaveLength(1);
  });

  it.each([null, ""])(
    "a job with description %j is skipped: no LLM call, no job_scores row, throws EmptyJobDescriptionError",
    async (description) => {
      const source = await insertSource(state.testDb);
      const job = await insertJob(state.testDb, source.id, { description });
      const resume = await insertResume(state.testDb);
      const complete = vi.fn(async () => {
        throw new Error("LLM must not be called for a job with no description");
      });
      const llm: LlmClient = { complete };

      await expect(scoreJob({ job, resume, llm })).rejects.toThrow(EmptyJobDescriptionError);
      expect(complete).not.toHaveBeenCalled();

      const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
      expect(rows).toHaveLength(0);
    },
  );
});
