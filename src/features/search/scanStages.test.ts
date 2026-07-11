import { describe, expect, it } from "vitest";
import type { Progress } from "@/types";
import { SCAN_STAGES, SCAN_STAGE_LABELS, initialStages, applyProgress, completeAllStages } from "./scanStages";

function progress(stage: string, current = 0, total = 0, label = ""): Progress {
  return { stage, current, total, label };
}

describe("scanStages", () => {
  it("starts every stage pending, in contract order", () => {
    const stages = initialStages();
    expect(stages.map((s) => s.stage)).toEqual(SCAN_STAGES);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
    expect(stages[0].label).toBe(SCAN_STAGE_LABELS.sources);
  });

  it("marks the reported stage active and carries its live counts/detail", () => {
    const stages = applyProgress(initialStages(), progress("score", 4, 30, "4/30 scored"));
    const score = stages.find((s) => s.stage === "score")!;
    expect(score.state).toBe("active");
    expect(score.current).toBe(4);
    expect(score.total).toBe(30);
    expect(score.detail).toBe("4/30 scored");
  });

  it("marks all earlier stages done when a later stage becomes active", () => {
    const stages = applyProgress(initialStages(), progress("score", 1, 30, "1/30 scored"));
    expect(stages.find((s) => s.stage === "sources")!.state).toBe("done");
    expect(stages.find((s) => s.stage === "fetch")!.state).toBe("done");
    expect(stages.find((s) => s.stage === "legitimacy")!.state).toBe("pending");
  });

  it("ignores an unrecognized stage string without throwing or mutating rows", () => {
    const before = applyProgress(initialStages(), progress("fetch", 2, 6, "2/6 source(s) done"));
    const after = applyProgress(before, progress("mystery-stage", 1, 1, "?"));
    expect(after).toEqual(before);
  });

  it("does not mutate the input array", () => {
    const before = initialStages();
    applyProgress(before, progress("sources", 0, 6, "Scanning 6 source(s)…"));
    expect(before.every((s) => s.state === "pending")).toBe(true);
  });

  it("completeAllStages marks every stage done (terminal `done` event)", () => {
    const mid = applyProgress(initialStages(), progress("legitimacy", 30, 30, "Legitimacy checks complete"));
    const done = completeAllStages(mid);
    expect(done.every((s) => s.state === "done")).toBe(true);
  });
});
