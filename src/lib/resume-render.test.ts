import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import { renderCvHtml } from "./resume-render";

function makeStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    storeVersion: 2,
    extractionPath: "text",
    name: "Jane Doe",
    contact: [{ label: "email", value: "jane@example.com" }],
    summary: "Backend engineer with 6 years of experience.",
    experience: [
      { company: "Acme Corp", title: "Senior Backend Engineer", dates: "2020–Present", isCurrent: true, bullets: ["Built the payments API"] },
    ],
    education: [{ school: "State University", credential: "B.Sc. Computer Science", dates: "2012–2016", details: [] }],
    skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [{ heading: "Additional Info", items: ["Speaks English and Malay"] }],
    ...overrides,
  };
}

describe("renderCvHtml", () => {
  it("is deterministic: same store in -> identical HTML out", () => {
    const store = makeStore();
    expect(renderCvHtml(store)).toBe(renderCvHtml(store));
    expect(renderCvHtml(makeStore())).toBe(renderCvHtml(makeStore()));
  });

  it("includes the candidate's name, experience, and skills", () => {
    const html = renderCvHtml(makeStore());
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Senior Backend Engineer");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("Built the payments API");
    expect(html).toContain("TypeScript");
    expect(html).toContain("Go");
  });

  it("escapes HTML-significant characters so résumé content can't inject markup", () => {
    const html = renderCvHtml(makeStore({ summary: '<script>alert("x")</script>' }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders projects with an optional url and their bullets", () => {
    const html = renderCvHtml(
      makeStore({
        projects: [
          { name: "Ledger Reconciler", url: "https://github.com/jane/ledger-reconciler", bullets: ["Reconciled 1M+ daily transactions"] },
          { name: "Side Project", bullets: [] },
        ],
      }),
    );
    expect(html).toContain("Ledger Reconciler");
    expect(html).toContain("https://github.com/jane/ledger-reconciler");
    expect(html).toContain("Reconciled 1M+ daily transactions");
    expect(html).toContain("Side Project");
  });

  it("renders certifications with optional issuer/year", () => {
    const html = renderCvHtml(
      makeStore({
        certifications: [
          { name: "AWS Certified Solutions Architect", issuer: "Amazon Web Services", year: "2023" },
          { name: "Unaffiliated Cert" },
        ],
      }),
    );
    expect(html).toContain("AWS Certified Solutions Architect");
    expect(html).toContain("Amazon Web Services");
    expect(html).toContain("2023");
    expect(html).toContain("Unaffiliated Cert");
  });

  it("renders languages with optional proficiency", () => {
    const html = renderCvHtml(
      makeStore({
        languages: [
          { language: "Malay", proficiency: "Native" },
          { language: "English" },
        ],
      }),
    );
    expect(html).toContain("Malay");
    expect(html).toContain("Native");
    expect(html).toContain("English");
  });

  it("escapes HTML-significant characters in the new sections", () => {
    const html = renderCvHtml(
      makeStore({
        projects: [{ name: '<script>alert("p")</script>', bullets: [] }],
        certifications: [{ name: '<script>alert("c")</script>' }],
        languages: [{ language: '<script>alert("l")</script>' }],
      }),
    );
    expect(html).not.toContain("<script>");
  });
});
