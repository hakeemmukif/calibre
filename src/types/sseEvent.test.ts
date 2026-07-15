import { describe, expect, it } from "vitest";
import { SseEvent } from "./index";

describe("SseEvent M2 additions", () => {
  it("parses a source delta", () => {
    const e = SseEvent.parse({ event: "source", data: { sourceId: "s1", name: "Greenhouse", status: "fetching" } });
    expect(e.event).toBe("source");
  });
  it("parses a jobPhase delta with a sub-phase", () => {
    const e = SseEvent.parse({ event: "jobPhase", data: { jobId: "j1", title: "DE", company: "Acme", source: "s1", phase: "scoring" } });
    expect(e.event).toBe("jobPhase");
  });
  it("parses a snapshot frame", () => {
    const e = SseEvent.parse({ event: "snapshot", data: { sources: [], activeJobs: [], counts: { scored: 0, queued: 30, total: 30 } } });
    expect(e.event).toBe("snapshot");
  });
  it("rejects an unknown phase", () => {
    expect(() => SseEvent.parse({ event: "jobPhase", data: { jobId: "j", title: "t", company: "c", source: "s", phase: "teleporting" } })).toThrow();
  });
});
