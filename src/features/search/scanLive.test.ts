import { describe, expect, it } from "vitest";
import { foldScanEvent, EMPTY_LIVE } from "./scanLive";

const src = (id: string, status: any) => ({ event: "source" as const, data: { sourceId: id, name: id, status } });
const jp = (id: string, phase: any) => ({ event: "jobPhase" as const, data: { jobId: id, title: id, company: "C", source: "s", phase } });

describe("foldScanEvent", () => {
  it("hydrates from a snapshot", () => {
    const s = foldScanEvent(EMPTY_LIVE, { event: "snapshot", data: { sources: [{ sourceId: "s1", name: "GH", status: "done", found: 5 }], activeJobs: [{ jobId: "j1", title: "t", company: "c", source: "s1", phase: "scoring" }], counts: { scored: 0, queued: 1, total: 1 } } });
    expect(s.sources).toHaveLength(1);
    expect(s.activeJobs[0].slot).toBe(0);
  });
  it("is idempotent — a duplicate source delta doesn't duplicate the row", () => {
    let s = foldScanEvent(EMPTY_LIVE, src("s1", "fetching"));
    s = foldScanEvent(s, src("s1", "fetching"));
    s = foldScanEvent(s, src("s1", "done"));
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0].status).toBe("done");
  });
  it("folds score progress deltas into counts even without a snapshot", () => {
    let s = foldScanEvent(EMPTY_LIVE, { event: "progress", data: { stage: "score", current: 6, total: 30, label: "6/30 scored" } });
    expect(s.counts).toEqual({ scored: 6, total: 30, queued: 24 });
    s = foldScanEvent(s, { event: "progress", data: { stage: "sources", current: 3, total: 8, label: "…" } }); // non-score ignored
    expect(s.counts.scored).toBe(6);
  });
  it("keeps a job's slot stable across phase changes and frees it on done", () => {
    let s = foldScanEvent(EMPTY_LIVE, jp("j1", "fetching"));
    let s2 = foldScanEvent(s, jp("j2", "fetching"));
    const j1slot = s2.activeJobs.find((j) => j.jobId === "j1")!.slot;
    s2 = foldScanEvent(s2, jp("j1", "scoring"));
    expect(s2.activeJobs.find((j) => j.jobId === "j1")!.slot).toBe(j1slot); // stable
    s2 = foldScanEvent(s2, jp("j1", "done"));
    expect(s2.activeJobs.find((j) => j.jobId === "j1")).toBeUndefined(); // freed
    // j3 reuses j1's freed slot
    s2 = foldScanEvent(s2, jp("j3", "fetching"));
    expect(s2.activeJobs.find((j) => j.jobId === "j3")!.slot).toBe(j1slot);
  });
});
