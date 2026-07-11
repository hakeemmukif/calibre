import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import { computeAtsScore } from "./atsScore";

function emptyStore(): ResumeStore {
  return { name: "", contact: [], summary: "", experience: [], education: [], skills: [], extras: [] };
}

describe("computeAtsScore", () => {
  it("scores a fully empty résumé at 0", () => {
    expect(computeAtsScore(emptyStore())).toBe(0);
  });

  it("scores a complete résumé at the documented fixed value", () => {
    const store: ResumeStore = {
      name: "Jane Doe",
      contact: [
        { label: "email", value: "jane@example.com" },
        { label: "phone", value: "+60 12-345 6789" },
        { label: "location", value: "Kuala Lumpur" },
      ],
      summary:
        "Backend engineer with six years of experience designing and operating distributed systems at scale.",
      experience: [
        { company: "Acme", title: "Senior Engineer", dates: "2022–Present", bullets: ["Led migration"] },
        { company: "Beta", title: "Engineer", dates: "2019–2022", bullets: ["Built pipeline"] },
      ],
      education: [],
      skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
      extras: [],
    };
    // summary(20) + experience(2 entries * 10 = 20) + skills(2) + contact(3*3=9) = 51
    expect(computeAtsScore(store)).toBe(51);
  });

  it("caps experience score at 4 entries with bullets", () => {
    const store: ResumeStore = {
      name: "",
      contact: [],
      summary: "",
      experience: Array.from({ length: 6 }, (_, i) => ({
        company: `Co ${i}`,
        title: "Engineer",
        dates: "2020",
        bullets: ["Did a thing"],
      })),
      education: [],
      skills: [],
      extras: [],
    };
    expect(computeAtsScore(store)).toBe(40);
  });

  it("does not count experience entries with no bullets", () => {
    const store: ResumeStore = {
      name: "",
      contact: [],
      summary: "",
      experience: [{ company: "Co", title: "Engineer", dates: "2020", bullets: [] }],
      education: [],
      skills: [],
      extras: [],
    };
    expect(computeAtsScore(store)).toBe(0);
  });

  it("caps skills score at 25 distinct items", () => {
    const store: ResumeStore = {
      name: "",
      contact: [],
      summary: "",
      experience: [],
      education: [],
      skills: [{ label: "All", items: Array.from({ length: 40 }, (_, i) => `Skill ${i}`) }],
      extras: [],
    };
    expect(computeAtsScore(store)).toBe(25);
  });

  it("stays within 0–100 bounds", () => {
    const score = computeAtsScore(emptyStore());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("is deterministic for the same input", () => {
    const store = emptyStore();
    expect(computeAtsScore(store)).toBe(computeAtsScore(store));
  });
});
