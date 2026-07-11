import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import { renderCvHtml } from "./resume-render";

function makeStore(overrides: Partial<ResumeStore> = {}): ResumeStore {
  return {
    name: "Jane Doe",
    contact: [{ label: "email", value: "jane@example.com" }],
    summary: "Backend engineer with 6 years of experience.",
    experience: [
      { company: "Acme Corp", title: "Senior Backend Engineer", dates: "2020–Present", bullets: ["Built the payments API"] },
    ],
    education: [{ school: "State University", credential: "B.Sc. Computer Science", dates: "2012–2016" }],
    skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
    extras: ["Speaks English and Malay"],
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
});
