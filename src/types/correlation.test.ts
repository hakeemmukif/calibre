import { describe, expect, it } from "vitest";
import { CorrelationReport, CorrelationRow, TailoredResume } from "./index";

describe("correlation contract", () => {
  it("parses a CorrelationRow with evidence", () => {
    const row = CorrelationRow.parse({
      requirement: "5+ years building distributed backend systems",
      term: "distributed systems", kind: "must", status: "met",
      evidence: "Led distributed payments platform at Paywatch", atsPresent: true,
      reason: "Direct match in current role", note: null,
    });
    expect(row.status).toBe("met");
  });

  it("rejects an unknown status", () => {
    expect(() => CorrelationRow.parse({
      requirement: "x", term: "x", kind: "must", status: "partial",
      evidence: null, atsPresent: false, reason: "r", note: null,
    })).toThrow();
  });

  it("parses a CorrelationReport with two separate signals", () => {
    const report = CorrelationReport.parse({
      id: "r1", jobId: "j1", resumeId: "cv1", status: "completed", progress: null,
      rows: [], semantic: { met: 0, buried: 0, gap: 0, total: 0 },
      ats: { present: 0, total: 0, missing: [] },
      model: "openai/gpt-oss-120b", costUsd: 0.0004,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    expect(report.ats.missing).toEqual([]);
  });

  it("parses a TailoredResume diff entry with target addressing", () => {
    const t = TailoredResume.parse({
      id: "t1", jobId: "j1", resumeId: "cv1", status: "completed", progress: null,
      reportId: "r1", atsDelta: null, resume: null,
      diff: [{ section: "experience", op: "modify", before: "b", after: "a",
        reason: "why", requirement: "distributed systems",
        target: { index: 0, bulletIndex: 1 } }],
      model: "m", createdAt: new Date().toISOString(), completedAt: null,
    });
    expect(t.diff[0].target.bulletIndex).toBe(1);
  });
});
