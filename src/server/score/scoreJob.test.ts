import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import type { ProfileRow } from "@/server/persistence/repos/profile";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { WebEvidence } from "@/types";
import type { EvalScores } from "./evalScores";
import type { JdFacts, JdFactsEmit } from "./jdFacts";

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

// extractJdFacts (Task 3, remote-fit) now emits via JdFactsEmitSchema — every
// field required, scalars nullable — so the mocked "jd-extract" response
// must be emit-shaped, distinct from `jdFacts` above (which stays tolerant
// JdFacts-shaped for precomputedJdFacts/assertions, since JdFacts's
// `.optional()` fields reject `null`).
const jdFactsRaw: JdFactsEmit = {
  title: "Backend Engineer",
  isJobPosting: true,
  company: null,
  seniority: null,
  employmentType: null,
  location: null,
  remotePolicy: null,
  hiringScope: null,
  hiringCountries: null,
  salaryRange: null,
  mustHaves: ["TypeScript"],
  niceToHaves: [],
  responsibilities: ["Ship features"],
  redFlags: [],
  tzRequirement: null,
  hiringStructure: null,
  workCalendar: null,
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
  let profile: ProfileRow;

  beforeAll(async () => {
    state.testDb = await createTestDb();
    profile = await insertProfile(state.testDb); // afterEach never wipes the profile singleton
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
    const llm = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": cheapEval });

    const row = await scoreJob({ job, source, profile, resume, llm });

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
    const llm = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": cheapEval });

    const row = await scoreJob({ job, source, profile, resume, llm });
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
          return { data: args.responseSchema.parse(jdFactsRaw), model: "cheap-jd-model", costUsd: 0.001 };
        }
        expect(args.modelOverride).toBeUndefined();
        return {
          data: args.responseSchema.parse({ ...cheapEval, lowConfidence: true }),
          model: "cheap-match-model",
          costUsd: 0.002,
        };
      },
    };

    const row = await scoreJob({ job, source, profile, resume, llm });

    expect(row.escalated).toBe(false);
    expect(row.model).toBe("cheap-match-model");
    expect(row.costUsd).toBeCloseTo(0.001 + 0.002);
  });

  it("verdict-cache: re-scoring the same (jobId, resumeId, policyVersion) updates the existing row instead of throwing", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role." });
    const resume = await insertResume(state.testDb);
    const llm = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": cheapEval });

    const first = await scoreJob({ job, source, profile, resume, llm });

    const updatedEval: EvalScores = { ...cheapEval, score: 2.1, verdict: "Skip" };
    const llm2 = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": updatedEval });
    const second = await scoreJob({ job, source, profile, resume, llm: llm2 });

    expect(second.id).toBe(first.id);
    expect(second.score).toBeCloseTo(2.1);
    expect(second.verdict).toBe("Skip");

    const rows = await state.testDb.select().from(jobScores);
    expect(rows.filter((r) => r.jobId === job.id)).toHaveLength(1);
  });

  it("refreshes jobs.eligibility from JD-stated hiring scope (Layer C, spec §5)", async () => {
    const source = await insertSource(state.testDb); // default prior: restricted
    const job = await insertJob(state.testDb, source.id, { description: "Backend role.", location: "Remote" });
    const resume = await insertResume(state.testDb);
    const usOnlyRaw: JdFactsEmit = { ...jdFactsRaw, hiringScope: "restricted", hiringCountries: ["United States"] };
    const llm = makeMockLlm({ "jd-extract": usOnlyRaw, "match-score": cheapEval });

    expect(job.eligibility).toBe("unknown"); // fixture's ingest-time stamp

    await scoreJob({ job, source, profile, resume, llm });

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.eligibility).toBe("abroad");
    expect(after.eligibilityEvidence).toBe("JD: hires only in United States");
  });

  it("refreshes jobs.tz_band/hiring_structure from JD-stated facts (spec §5)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role.", location: "Remote" });
    const resume = await insertResume(state.testDb);
    const remoteFitRaw: JdFactsEmit = { ...jdFactsRaw, tzRequirement: "PST", hiringStructure: "contractor" };
    const llm = makeMockLlm({ "jd-extract": remoteFitRaw, "match-score": cheapEval });

    expect(job.tzBand).toBeNull();
    expect(job.hiringStructure).toBeNull();

    await scoreJob({ job, source, profile, resume, llm });

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBe("americas");
    expect(after.hiringStructure).toBe("contractor");
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

      await expect(scoreJob({ job, source, profile, resume, llm })).rejects.toThrow(EmptyJobDescriptionError);
      expect(complete).not.toHaveBeenCalled();

      const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
      expect(rows).toHaveLength(0);
    },
  );

  it("precomputedJdFacts (paste path, spec §6) skips extractJdFacts entirely", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Pasted JD text." });
    const resume = await insertResume(state.testDb);
    const llm: LlmClient = {
      async complete(args) {
        if (args.task === "jd-extract") {
          throw new Error("extractJdFacts must not run when precomputedJdFacts is supplied");
        }
        return { data: args.responseSchema.parse(cheapEval), model: "cheap-match-model", costUsd: 0.002 };
      },
    };

    const row = await scoreJob({ job, source, profile, resume, llm, precomputedJdFacts: jdFacts });

    expect(row.jdFacts).toEqual(jdFacts);
    expect(row.costUsd).toBeCloseTo(0.002); // jd-extract cost is 0 — already paid by the url-check ladder
  });

  it("livenessOverride (paste path) skips probeLivenessDeep and is honoured in job_scores.liveness", async () => {
    vi.mocked(probeLivenessDeep).mockClear();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Pasted JD text." });
    const resume = await insertResume(state.testDb);
    const llm = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": cheapEval });

    const row = await scoreJob({ job, source, profile, resume, llm, livenessOverride: "uncertain" });

    expect(probeLivenessDeep).not.toHaveBeenCalled();
    expect(row.liveness).toBe("uncertain");
  });

  it("threads webEvidence through to the legitimacy overlay and persists it in job_scores.legitimacy (spec §6/§9)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Pasted JD text." });
    const resume = await insertResume(state.testDb);
    const verifiedEval: EvalScores = {
      ...cheapEval,
      legitimacy: { tier: "verified", summary: "Careers page confirms opening.", signals: [], corroborated: true },
    };
    const llm = makeMockLlm({ "jd-extract": jdFactsRaw, "match-score": verifiedEval });
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [{ url: "https://www.linkedin.com/jobs/view/123", source: "LinkedIn" }],
      companySignals: [],
      summary: "Seen on LinkedIn only — no ATS-hosted posting found.",
      confidence: 0.7,
    };

    const row = await scoreJob({ job, source, profile, resume, llm, livenessOverride: "active", webEvidence });

    // §9 step 3b: self-certified corroboration from pasted (attacker-
    // controlled) page text is not corroboration without an ATS-allowlisted
    // sighting — differs from the pre-webEvidence 3a result ("verified").
    expect(row.legitimacy.tier).toBe("clear");
    expect(row.legitimacy.webEvidence).toEqual(webEvidence);

    const [persisted] = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(persisted.legitimacy.webEvidence).toEqual(webEvidence);
  });
});
