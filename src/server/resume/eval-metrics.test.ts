// Deterministic unit tests for eval-metrics.ts — no LLM, hand-built
// store/expected/rawText literals. Runs in the normal (non-live) gate.
import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import {
  EVAL_BASELINE,
  EVAL_EPSILON,
  containmentViolations,
  conceptRecall,
  dateAtomMatch,
  fuzzyContains,
  scoreGolden,
} from "./eval-metrics";

function baseStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    storeVersion: 2,
    extractionPath: "text",
    name: "REDACTED_NAME",
    contact: [],
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
    ...overrides,
  };
}

describe("fuzzyContains", () => {
  it("matches a token-reordered / de-scrambled value", () => {
    const haystack = "REDACTED_NAME, PMP Product-Focused UX / Pre-Sales Specialist";
    expect(fuzzyContains(haystack, "REDACTED_NAME")).toBe(true);
  });

  it("returns false for a genuinely-absent value", () => {
    const haystack = "REDACTED_NAME, PMP Product-Focused UX / Pre-Sales Specialist";
    expect(fuzzyContains(haystack, "Software Engineer")).toBe(false);
  });

  it("tolerates a PDF intra-word space break in the haystack", () => {
    expect(fuzzyContains("Pro blem scoping and requirements", "Problem scoping")).toBe(true);
  });

  it("tolerates multiple intra-word breaks across a longer bullet", () => {
    const haystack = "D esigned Web 3.0 products using Figma";
    expect(fuzzyContains(haystack, "Designed Web 3.0 products using Figma")).toBe(true);
  });

  it("still matches a token-reordered de-scramble (regression)", () => {
    expect(fuzzyContains("REDACTED_NAME, PMP", "REDACTED_NAME")).toBe(true);
  });

  it("still catches a hallucination absent from the haystack blob", () => {
    expect(fuzzyContains("designer with figma experience", "blockchain architecture")).toBe(false);
  });

  it("does not let a short/digit token pass via substring fallback", () => {
    // "5" is a substring of almost any blob with digits in it — the
    // alphabetic + length>=4 guard must keep digits on exact-membership only.
    expect(fuzzyContains("completed migration in 3 days", "completed migration in 5 days")).toBe(false);
  });

  it("does not let a hallucinated skill pass as an interior substring of a real haystack token", () => {
    // "Java" is a substring of "JavaScript" — the blob fallback must not let
    // this pass as a faithful de-scramble repair.
    expect(fuzzyContains("proficient in JavaScript", "Java")).toBe(false);
  });

  it("still matches a token that is present as its own whole haystack token", () => {
    expect(fuzzyContains("Skilled in Java, JavaScript", "Java")).toBe(true);
  });
});

describe("conceptRecall", () => {
  it("counts a fuzzy near-match and misses a genuinely-absent concept", () => {
    const expected = ["PMP", "Missing Cert"];
    const extracted = ["Project Management Professional (PMP)"];
    const result = conceptRecall(expected, extracted);
    expect(result).toEqual({ found: 1, total: 2, recall: 0.5 });
  });

  it("treats an empty expected list as trivially satisfied", () => {
    expect(conceptRecall([], ["anything"])).toEqual({ found: 0, total: 0, recall: 1 });
  });
});

describe("dateAtomMatch", () => {
  it("fails on a start mismatch", () => {
    const expected = { start: "2020-01", end: "2020-06", isCurrent: false };
    const actual = { start: "2020-02", end: "2020-06", isCurrent: false };
    expect(dateAtomMatch(expected, actual)).toBe(false);
  });

  it("passes on year-only (null) atoms matching undefined atoms", () => {
    const expected = { start: null, end: null, isCurrent: false };
    const actual = { start: undefined, end: undefined, isCurrent: false };
    expect(dateAtomMatch(expected, actual)).toBe(true);
  });
});

describe("containmentViolations", () => {
  const rawText = "REDACTED_NAME, PMP. Skilled in Figma and stakeholder alignment. Led UX ideation.";

  it("returns empty for a clean store", () => {
    const store = baseStore({
      name: "REDACTED_NAME",
      skills: [{ items: ["Figma"] }],
      experience: [
        {
          company: "Techtics Solutions",
          title: "UI/UX Designer",
          dates: "2021-2024",
          isCurrent: false,
          bullets: ["Led UX ideation"],
        },
      ],
    });
    expect(containmentViolations(store, rawText)).toEqual([]);
  });

  it("flags a hallucinated skill not present in rawText", () => {
    const store = baseStore({
      name: "REDACTED_NAME",
      skills: [{ items: ["Figma", "Kubernetes"] }],
    });
    const violations = containmentViolations(store, rawText);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Kubernetes");
  });

  it("flags a hallucinated digit even when every other token matches", () => {
    const digitRawText = "REDACTED_NAME, PMP. Completed migration in 3 days.";
    const store = baseStore({
      name: "REDACTED_NAME",
      experience: [
        {
          company: "Techtics Solutions",
          title: "UI/UX Designer",
          dates: "2021-2024",
          isCurrent: false,
          bullets: ["Completed migration in 5 days"],
        },
      ],
    });
    const violations = containmentViolations(store, digitRawText);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Completed migration in 5 days");
  });
});

describe("scoreGolden", () => {
  it("scores an aggregate between 0 and 1 and folds containment into it", () => {
    const rawText = "REDACTED_NAME, PMP. Skilled in Figma.";
    const store = baseStore({
      name: "REDACTED_NAME",
      skills: [{ items: ["Figma", "Hallucinated Skill"] }],
    });
    const expected = {
      name: "REDACTED_NAME",
      certifications: [],
      languages: [],
      projects: [],
      roles: [],
    };
    const score = scoreGolden(expected, store, rawText);
    expect(score.containmentScore).toBe(0); // hallucinated skill present
    expect(score.aggregate).toBeGreaterThanOrEqual(0);
    expect(score.aggregate).toBeLessThanOrEqual(1);
  });
});

describe("EVAL_BASELINE / EVAL_EPSILON", () => {
  it("are conservative starting constants, pending live calibration", () => {
    expect(EVAL_BASELINE).toBeGreaterThan(0);
    expect(EVAL_BASELINE).toBeLessThanOrEqual(1);
    expect(EVAL_EPSILON).toBeGreaterThan(0);
  });
});
