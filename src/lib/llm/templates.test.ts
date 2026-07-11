import { describe, expect, it } from "vitest";
import type { TaskName } from "./client";
import { policyVersion, renderTemplate } from "./templates";

describe("policyVersion", () => {
  it("is stable across repeated calls for the same task", () => {
    expect(policyVersion("resume-extract")).toBe(policyVersion("resume-extract"));
  });

  it("differs for templates with different file bytes", () => {
    expect(policyVersion("resume-extract")).not.toBe(policyVersion("jd-extract"));
  });

  it("is a 12-hex-char sha256 prefix", () => {
    expect(policyVersion("resume-extract")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("renderTemplate", () => {
  it("fills {{var}} placeholders in every block", () => {
    const messages = renderTemplate("jd-extract", { jobDescription: "Senior Engineer at Acme" });
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("Senior Engineer at Acme");
    expect(joined).not.toMatch(/\{\{\w+\}\}/);
  });

  it("puts the candidate/résumé block last regardless of file position", () => {
    const messages = renderTemplate("match-score", { jdFacts: "FACTS_MARKER", resume: "RESUME_MARKER" });
    expect(messages.at(-1)?.content).toContain("RESUME_MARKER");
    expect(messages.some((m) => m.content.includes("FACTS_MARKER"))).toBe(true);
    expect(messages.at(-1)?.content).not.toContain("FACTS_MARKER");
  });

  it("emits the system block with role 'system'", () => {
    const messages = renderTemplate("resume-extract", { rawText: "raw" });
    expect(messages[0].role).toBe("system");
  });

  it("throws on an unknown task", () => {
    expect(() => renderTemplate("not-a-real-task" as TaskName, {})).toThrow(/unknown task/i);
  });

  it("throws when a required var is missing", () => {
    expect(() => renderTemplate("jd-extract", {})).toThrow(/missing template variable/i);
  });
});
