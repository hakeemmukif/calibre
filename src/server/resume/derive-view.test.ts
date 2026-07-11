import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import { ParseFailedError, toResumeView } from "./derive-view";

function baseStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    name: "Jane Doe",
    contact: [
      { label: "email", value: "jane@example.com" },
      { label: "Location", value: "Kuala Lumpur, Malaysia" },
      { label: "Headline", value: "Senior Backend Engineer" },
    ],
    summary: "Backend engineer with 6 years building distributed systems.",
    experience: [
      {
        company: "Acme Co",
        title: "Senior Backend Engineer",
        dates: "2022–Present",
        bullets: ["Led migration to Kubernetes", "Cut p99 latency by 40%"],
        location: "Kuala Lumpur",
      },
    ],
    education: [],
    skills: [
      { label: "Languages", items: ["TypeScript", "Go", "TypeScript"] },
      { label: "Cloud", items: ["AWS", "Go"] },
    ],
    extras: [],
    ...overrides,
  };
}

const opts = { id: "r1", atsScore: 80, updatedAt: "2026-07-11T00:00:00.000Z", rawText: "raw résumé text" };

describe("toResumeView", () => {
  it("derives the correct Resume view from a ResumeStore", () => {
    const resume = toResumeView(baseStore(), opts);

    expect(resume).toEqual({
      id: "r1",
      atsScore: 80,
      updatedAt: "2026-07-11T00:00:00.000Z",
      headline: "Senior Backend Engineer",
      location: "Kuala Lumpur, Malaysia",
      summary: "Backend engineer with 6 years building distributed systems.",
      experience: [
        {
          title: "Senior Backend Engineer",
          company: "Acme Co",
          dates: "2022–Present",
          bullets: ["Led migration to Kubernetes", "Cut p99 latency by 40%"],
        },
      ],
      skills: ["TypeScript", "Go", "AWS"],
      rawText: "raw résumé text",
    });
  });

  it("flattens and dedupes skills across groups preserving first-seen order", () => {
    const resume = toResumeView(baseStore(), opts);
    expect(resume.skills).toEqual(["TypeScript", "Go", "AWS"]);
  });

  it("drops experience.location when mapping to the wire shape", () => {
    const resume = toResumeView(baseStore(), opts);
    expect(resume.experience[0]).not.toHaveProperty("location");
  });

  it("falls back to the most recent experience location when no contact line matches", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
    });
    const resume = toResumeView(store, opts);
    expect(resume.location).toBe("Kuala Lumpur");
  });

  it("falls back to the most recent experience title for headline when no contact line matches", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
    });
    const resume = toResumeView(store, opts);
    expect(resume.headline).toBe("Senior Backend Engineer");
  });

  it("throws ParseFailedError when location cannot be derived", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [
        {
          company: "Acme Co",
          title: "Senior Backend Engineer",
          dates: "2022–Present",
          bullets: ["Led migration to Kubernetes"],
        },
      ],
    });
    expect(() => toResumeView(store, opts)).toThrow(ParseFailedError);
  });

  it("throws ParseFailedError when headline cannot be derived", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [],
    });
    expect(() => toResumeView(store, opts)).toThrow(ParseFailedError);
  });
});
