import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import { assertResumeViewDerivable, ParseFailedError, toResumeView } from "./derive-view";

function baseStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    storeVersion: 2,
    extractionPath: "text",
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
        isCurrent: true,
        bullets: ["Led migration to Kubernetes", "Cut p99 latency by 40%"],
        location: "Kuala Lumpur",
      },
    ],
    education: [],
    skills: [
      { label: "Languages", items: ["TypeScript", "Go", "TypeScript"] },
      { label: "Cloud", items: ["AWS", "Go"] },
    ],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
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

  it("prefers the top-level location field over contact and experience", () => {
    const store = baseStore({ location: "Penang, Malaysia" });
    const resume = toResumeView(store, opts);
    expect(resume.location).toBe("Penang, Malaysia");
  });

  it("derives location from the top-level field when no contact line matches and experience has none", () => {
    const store = baseStore({
      location: "Kuala Lumpur, Malaysia",
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [
        {
          company: "Acme Co",
          title: "Senior Backend Engineer",
          dates: "2022–Present",
          isCurrent: true,
          bullets: ["Led migration to Kubernetes"],
        },
      ],
    });
    const resume = toResumeView(store, opts);
    expect(resume.location).toBe("Kuala Lumpur, Malaysia");
  });

  it("treats an empty top-level location as absent and still throws when nothing else derives one", () => {
    const store = baseStore({
      location: "",
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [
        {
          company: "Acme Co",
          title: "Senior Backend Engineer",
          dates: "2022–Present",
          isCurrent: true,
          bullets: ["Led migration to Kubernetes"],
        },
      ],
    });
    expect(() => toResumeView(store, opts)).toThrow(ParseFailedError);
  });

  it("throws ParseFailedError when location cannot be derived", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [
        {
          company: "Acme Co",
          title: "Senior Backend Engineer",
          dates: "2022–Present",
          isCurrent: true,
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

  it("prefers store.headline over contact and experience", () => {
    const store = baseStore({ headline: "Staff Platform Engineer" });
    const resume = toResumeView(store, opts);
    expect(resume.headline).toBe("Staff Platform Engineer");
  });

  it("prefers experience[0].title over education when both present", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      education: [{ school: "University of Malaya", credential: "B.Sc. Computer Science", dates: "2018–2022", details: [] }],
    });
    const resume = toResumeView(store, opts);
    expect(resume.headline).toBe("Senior Backend Engineer");
  });

  it("derives headline from education credential for an education-only fresh-grad résumé with no summary, and does not throw", () => {
    const store = baseStore({
      contact: [
        { label: "email", value: "jane@example.com" },
        { label: "location", value: "Kuala Lumpur, Malaysia" },
      ],
      summary: undefined,
      experience: [],
      education: [{ school: "University of Malaya", credential: "B.Sc. Computer Science", dates: "2022–2026", details: [] }],
    });

    expect(() => assertResumeViewDerivable(store)).not.toThrow();

    const resume = toResumeView(store, opts);
    expect(resume.headline).toBe("B.Sc. Computer Science");
    expect(resume.location).toBe("Kuala Lumpur, Malaysia");
    expect(resume.summary).toBeUndefined();
  });

  it("falls back to the education school when no credential is present", () => {
    const store = baseStore({
      contact: [
        { label: "email", value: "jane@example.com" },
        { label: "location", value: "Kuala Lumpur, Malaysia" },
      ],
      experience: [],
      education: [{ school: "University of Malaya", dates: "2022–2026", details: [] }],
    });
    const resume = toResumeView(store, opts);
    expect(resume.headline).toBe("University of Malaya");
  });

  it("still throws ParseFailedError when no headline source exists at all, including education", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [],
      education: [],
    });
    expect(() => toResumeView(store, opts)).toThrow(ParseFailedError);
  });

  it("location still fails loud when genuinely absent, even on an education-only résumé", () => {
    const store = baseStore({
      contact: [{ label: "email", value: "jane@example.com" }],
      experience: [],
      education: [{ school: "University of Malaya", credential: "B.Sc. Computer Science", dates: "2022–2026", details: [] }],
    });
    expect(() => toResumeView(store, opts)).toThrow(ParseFailedError);
  });
});
