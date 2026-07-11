import { describe, expect, it } from "vitest";
import { foldStatus, type AppOutcome } from "./status-map";

describe("foldStatus", () => {
  const stages = [0, 1, 2, 3] as const;
  const outcomes: AppOutcome[] = ["open", "offer", "closed"];

  // Full (stage x outcome) table — every tone must be reachable, and tone is
  // driven by outcome alone (task-B9-brief.md: 'verified'/'neutral' are
  // unreachable from stage).
  const expected: Record<AppOutcome, { tone: "good" | "verified" | "neutral"; label: (s: 0 | 1 | 2 | 3) => string }> = {
    open: {
      tone: "good",
      label: (s) => ["Applied", "Screening", "Interviewing", "Awaiting decision"][s],
    },
    offer: { tone: "verified", label: () => "Offer" },
    closed: { tone: "neutral", label: () => "Rejected" },
  };

  for (const outcome of outcomes) {
    for (const stage of stages) {
      it(`stage ${stage} + outcome '${outcome}' -> tone '${expected[outcome].tone}', label '${expected[outcome].label(stage)}'`, () => {
        const result = foldStatus(stage, outcome);
        expect(result.statusTone).toBe(expected[outcome].tone);
        expect(result.statusLabel).toBe(expected[outcome].label(stage));
      });
    }
  }

  it("every tone is reachable across the table", () => {
    const tones = new Set(outcomes.map((o) => foldStatus(0, o).statusTone));
    expect(tones).toEqual(new Set(["good", "verified", "neutral"]));
  });

  it("tone is driven by outcome, not stage: offer/closed are the same regardless of stage", () => {
    for (const stage of stages) {
      expect(foldStatus(stage, "offer")).toEqual({ statusLabel: "Offer", statusTone: "verified" });
      expect(foldStatus(stage, "closed")).toEqual({ statusLabel: "Rejected", statusTone: "neutral" });
    }
  });
});
