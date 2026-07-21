import { describe, expect, it } from "vitest";
import type { JobJoinScore } from "@/server/persistence/repos/jobs";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { assembleJob } from "./assemble";

function baseJoined(
  overrides: Partial<JobJoinScore["job"]> = {},
  scoreOverrides: Partial<JobJoinScore["score"]> = {},
): JobJoinScore {
  const job: JobJoinScore["job"] = {
    id: "job-1",
    userId: BOOTSTRAP_ADMIN_ID,
    dedupeKey: "dk-1",
    url: "https://example.com/jobs/1",
    applyUrl: null,
    sourceId: "greenhouse",
    externalId: null,
    title: "Backend Engineer",
    company: "Acme",
    location: "Remote",
    salaryRaw: "$120k-$150k",
    description: "Build things.",
    postedAt: null,
    firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
    persona: "remote",
    eligibility: "unknown",
    eligibilityEvidence: "test fixture",
    aliases: [],
    raw: {},
    tzBand: null,
    hiringStructure: null,
    postingId: null,
    ...overrides,
  };

  const score: JobJoinScore["score"] = {
    id: "score-1",
    userId: BOOTSTRAP_ADMIN_ID,
    jobId: job.id,
    resumeId: "resume-1",
    score: 4.2,
    verdict: "Apply",
    why: "Strong overlap with recent backend experience.",
    legitimacy: { tier: "clear", tone: "good", summary: "Established company.", signals: [] },
    liveness: "active",
    breakdown: [{ label: "Skills", value: 4.5 }],
    reasons: { for: ["Matches stack"], against: [] },
    fit: [{ k: "TypeScript", v: "5 years" }],
    gaps: [{ tone: "ok", k: "Cloud", v: "AWS present" }],
    jdFacts: {},
    model: "test-model",
    escalated: false,
    costUsd: 0.01,
    policyVersion: "v1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...scoreOverrides,
  };

  const source: JobJoinScore["source"] = {
    id: "greenhouse",
    name: "Greenhouse",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { job, score, source };
}

describe("assembleJob", () => {
  it("assembles a valid frozen Job (Job.parse passes)", () => {
    const job = assembleJob(baseJoined());
    expect(job.id).toBe("job-1");
    expect(job.role).toBe("Backend Engineer");
    expect(job.meta).toBe("Remote · $120k-$150k");
    expect(job.tags.find((t) => t.label === "Looks legit")?.tone).toBe("good");
    expect(job.legitimacy).toEqual({ tier: "clear", tone: "good", summary: "Established company.", confidence: undefined });
    expect(job.source).toEqual({ id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote" });
  });

  it("applyUrl falls back to the canonical url when jobs.applyUrl is null", () => {
    const job = assembleJob(baseJoined({ applyUrl: null }));
    expect(job.applyUrl).toBe("https://example.com/jobs/1");
  });

  it("applyUrl uses jobs.applyUrl when present (resolved redirect wins)", () => {
    const job = assembleJob(baseJoined({ applyUrl: "https://boards.greenhouse.io/acme/jobs/1" }));
    expect(job.applyUrl).toBe("https://boards.greenhouse.io/acme/jobs/1");
  });

  it("meta falls back to an em dash when salaryRaw is absent", () => {
    const job = assembleJob(baseJoined({ salaryRaw: null }));
    expect(job.meta).toBe("Remote · —");
  });

  it("ghost tier sets ghost:true and the ghost tone tag", () => {
    const joined = baseJoined();
    joined.score.legitimacy = { tier: "ghost", tone: "ghost", summary: "Posting is stale.", signals: [] };
    const job = assembleJob(joined);
    expect(job.ghost).toBe(true);
    expect(job.tags.find((t) => t.label === "Likely stale")?.tone).toBe("ghost");
  });

  it("emits eligibility from the job row — tags carry the legitimacy tag only (spec §8)", () => {
    const anywhere = assembleJob(
      baseJoined({ eligibility: "anywhere", eligibilityEvidence: "employer prior: hires anywhere" }),
    );
    expect(anywhere.eligibility).toEqual({
      tier: "anywhere",
      tone: "verified",
      summary: "employer prior: hires anywhere",
    });
    expect(anywhere.tags.find((t) => t.label === "Looks legit")?.tone).toBe("good");

    const local = assembleJob(baseJoined({ eligibility: "local", eligibilityEvidence: "MY board source" }));
    expect(local.eligibility.tier).toBe("local");
    expect(local.tags).toHaveLength(1); // legitimacy tag only
  });

  it("non-ghost tiers omit the `ghost` field entirely", () => {
    const job = assembleJob(baseJoined());
    expect(job.ghost).toBeUndefined();
  });

  it("isNew is true when firstSeenAt is after the given cutoff", () => {
    const joined = baseJoined({ firstSeenAt: new Date("2026-07-10T00:00:00.000Z") });
    const job = assembleJob(joined, { isNewCutoff: new Date("2026-07-05T00:00:00.000Z") });
    expect(job.isNew).toBe(true);
  });

  it("isNew is false when firstSeenAt is at/before the cutoff", () => {
    const joined = baseJoined({ firstSeenAt: new Date("2026-07-01T00:00:00.000Z") });
    const job = assembleJob(joined, { isNewCutoff: new Date("2026-07-05T00:00:00.000Z") });
    expect(job.isNew).toBe(false);
  });

  it("isNew is false when no cutoff is given (no prior completed run)", () => {
    const job = assembleJob(baseJoined());
    expect(job.isNew).toBe(false);
  });

  it("a joined row with no legitimacy throws (fail loud, no grey default)", () => {
    const joined = baseJoined();
    // Simulates a corrupt/legacy row bypassing the NOT NULL jsonb column's
    // application-level shape guarantee.
    (joined.score as unknown as { legitimacy: unknown }).legitimacy = null;
    expect(() => assembleJob(joined)).toThrow(/legitimacy/i);
  });

  it("appends a neutral schedule pill for a known non-apac band, with the verbatim tooltip; suppresses apac", () => {
    const a = assembleJob(baseJoined({ tzBand: "americas" }, { jdFacts: { tzRequirement: "4h overlap with PST" } }));
    const pill = a.tags.find((t) => t.label === "US hours");
    expect(pill?.tone).toBe("neutral");
    expect(pill?.title).toBe("4h overlap with PST");

    const b = assembleJob(baseJoined({ tzBand: "apac" }));
    expect(b.tags.find((t) => t.label === "APAC hours")).toBeUndefined();
  });

  it("suppresses the schedule pill for tzBand=worldwide (no fixed schedule to show)", () => {
    const a = assembleJob(baseJoined({ tzBand: "worldwide" }));
    expect(a.tags).toHaveLength(1); // legitimacy tag only
  });

  it("appends a structure pill only when stated", () => {
    const a = assembleJob(baseJoined({ hiringStructure: "contractor" }));
    expect(a.tags.find((t) => t.label === "Contractor")?.tone).toBe("neutral");

    const b = assembleJob(baseJoined({ hiringStructure: null }));
    expect(b.tags.some((t) => ["Contractor", "EOR", "Local entity"].includes(t.label))).toBe(false);
  });

  it("appends a workCalendar gap entry only when stated", () => {
    const a = assembleJob(baseJoined({}, { jdFacts: { workCalendar: "Mon-Fri, core hours 9am-5pm ET" } }));
    expect(a.gaps.find((g) => g.k === "Work calendar")).toEqual({
      tone: "warn",
      k: "Work calendar",
      v: "Mon-Fri, core hours 9am-5pm ET",
    });

    const b = assembleJob(baseJoined());
    expect(b.gaps.some((g) => g.k === "Work calendar")).toBe(false);
  });
});
