import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import { computeAtsScore } from "./atsScore";

function emptyStore(): ResumeStore {
  return {
    storeVersion: 2,
    extractionPath: "text",
    name: "",
    contact: [],
    summary: "",
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
  };
}

describe("computeAtsScore", () => {
  it("scores a fully empty résumé at 0", () => {
    expect(computeAtsScore(emptyStore())).toBe(0);
  });

  it("scores a complete résumé at the documented fixed value", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "Jane Doe",
      contact: [
        { label: "email", value: "jane@example.com" },
        { label: "phone", value: "+60 12-345 6789" },
        { label: "location", value: "Kuala Lumpur" },
      ],
      summary:
        "Backend engineer with six years of experience designing and operating distributed systems at scale.",
      experience: [
        { company: "Acme", title: "Senior Engineer", dates: "2022–Present", isCurrent: true, bullets: ["Led migration"] },
        { company: "Beta", title: "Engineer", dates: "2019–2022", isCurrent: false, bullets: ["Built pipeline"] },
      ],
      education: [],
      skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    // summary(16, 99 chars >=80) + experience(2 entries * 7 = 14) + skills(2)
    // + contact(3*3=9) + quantified(0, no digit/%/$ bullets) + certLang(0) = 41
    expect(computeAtsScore(store)).toBe(41);
  });

  it("caps experience score at 4 entries with bullets", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: Array.from({ length: 6 }, (_, i) => ({
        company: `Co ${i}`,
        title: "Engineer",
        dates: "2020",
        isCurrent: false,
        bullets: ["Did a thing"],
      })),
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    expect(computeAtsScore(store)).toBe(28);
  });

  it("does not count experience entries with no bullets", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: [{ company: "Co", title: "Engineer", dates: "2020", isCurrent: false, bullets: [] }],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    expect(computeAtsScore(store)).toBe(0);
  });

  it("caps skills score at 20 distinct items", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: [],
      education: [],
      skills: [{ label: "All", items: Array.from({ length: 40 }, (_, i) => `Skill ${i}`) }],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    expect(computeAtsScore(store)).toBe(20);
  });

  it("scores quantified bullets proportionally (digit/%/$ tokens)", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: [
        { company: "Co", title: "Engineer", dates: "2020", isCurrent: false, bullets: ["Grew revenue 40%", "Led the team", "Saved $2M in costs"] },
      ],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    };
    // experience(7, 1 entry with bullets) + quantified(round(2/3 * 16) = 11) = 18
    expect(computeAtsScore(store)).toBe(18);
  });

  it("awards cert/language presence points independent of count", () => {
    const store: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [{ name: "PMP" }],
      languages: [{ language: "English" }],
      sections: [],
    };
    expect(computeAtsScore(store)).toBe(8);
  });

  it("awards half the cert/language band when only one is present", () => {
    const withCertOnly: ResumeStore = {
      storeVersion: 2,
      extractionPath: "text",
      name: "",
      contact: [],
      summary: "",
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [{ name: "PMP" }],
      languages: [],
      sections: [],
    };
    expect(computeAtsScore(withCertOnly)).toBe(4);
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
