import { describe, expect, it } from "vitest";
import { ScanResult, SearchRunSummary, ScanDetail } from "./index";

describe("ScanResult", () => {
  it("accepts a scored row and rejects an unknown outcome", () => {
    const ok = ScanResult.parse({
      jobId: "j1", title: "Data Engineer", company: "Acme", source: "src-good",
      outcome: "scored", verdict: "Apply", legitimacyTier: "clear", fit: 4, scoredMs: 21000,
    });
    expect(ok.outcome).toBe("scored");
    expect(() => ScanResult.parse({ jobId: "j1", title: "t", company: "c", source: "s", outcome: "bogus" })).toThrow();
  });

  it("accepts a dailyCap skip and an error row", () => {
    expect(ScanResult.parse({ jobId: "j2", title: "t", company: "c", source: "s", outcome: "skipped", reason: "dailyCap" }).reason).toBe("dailyCap");
    expect(ScanResult.parse({ jobId: "j3", title: "t", company: "c", source: "s", outcome: "error", error: "boom" }).error).toBe("boom");
  });
});

describe("SearchRunSummary + ScanDetail", () => {
  const base = {
    id: "r1", status: "completed" as const, persona: "remote" as const,
    resumeName: "jane_v2.pdf", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stats: { scanned: 40, matched: 30, scored: 28, worth: 6, ghosts: 2, unscored: 1, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3" },
  };
  it("summary parses; detail requires results[]", () => {
    expect(SearchRunSummary.parse(base).resumeName).toBe("jane_v2.pdf");
    expect(() => ScanDetail.parse(base)).toThrow(); // no results[]
    expect(ScanDetail.parse({ ...base, error: null, results: [] }).results).toEqual([]);
  });
});
