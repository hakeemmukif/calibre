import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TaskName } from "./client";
import { policyVersion, renderTemplate } from "./templates";
import { ApplicationAnswer, ApplicationQuestion, LegitimacyTier, RequirementStatus } from "@/types";
import { EvalScoresSchema } from "@/server/score/evalScores";
import { DiffEntrySchema } from "@/server/tailor/merge";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

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
    const messages = renderTemplate("match-score", { jdFacts: "FACTS_MARKER", resume: "RESUME_MARKER", metrics: "METRICS_MARKER" });
    expect(messages.at(-1)?.content).toContain("RESUME_MARKER");
    expect(messages.some((m) => m.content.includes("FACTS_MARKER"))).toBe(true);
    expect(messages.at(-1)?.content).not.toContain("FACTS_MARKER");
  });

  it("emits the system block with role 'system'", () => {
    const messages = renderTemplate("resume-extract", { rawText: "raw" });
    expect(messages[0].role).toBe("system");
  });

  it("throws 'Unknown task' when the template file is missing (ENOENT)", () => {
    expect(() => renderTemplate("not-a-real-task" as TaskName, {})).toThrow(/unknown task/i);
  });

  it("rethrows non-ENOENT file errors unchanged instead of masking them as 'unknown task'", () => {
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw eacces;
    });
    expect(() => renderTemplate("resume-extract", { rawText: "raw" })).toThrow("permission denied");
  });

  it("throws when a required var is missing", () => {
    expect(() => renderTemplate("jd-extract", {})).toThrow(/missing template variable/i);
  });

  // Vision counterpart of resume-extract.md (task 5b-1): same v2 emit-schema
  // extraction instructions, framed for page images instead of {{rawText}} —
  // no vars needed, since the caller passes `images` on the LLM call instead.
  it("resume-extract-vision.md instructs the same v2 concepts, framed for images, with no {{rawText}} var", () => {
    const messages = renderTemplate("resume-extract-vision", {});
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toMatch(/image/i);
    expect(joined).toMatch(/headline/i);
    expect(joined).toMatch(/YYYY-MM/);
    expect(joined).toMatch(/certification/i);
    expect(joined).toMatch(/language/i);
    expect(joined).toMatch(/project/i);
    expect(joined).toMatch(/sections/i);
    expect(joined).toMatch(/column/i);
    expect(joined).toMatch(/PMP/);
    expect(joined).toMatch(/never.*summary|summary.*never/i);
    expect(joined).toMatch(/return only json/i);
  });

  // v2 upgrade (ResumeStoreEmitSchema now has 12 concepts, not 5): the
  // rendered prompt must actually instruct the model to look for all of
  // them and handle the failure modes live extraction surfaced — headline
  // swallowing the summary, credentials leaking into name, and 2-column PDF
  // text arriving with sidebar fragments interleaved mid-sentence.
  it("resume-extract.md instructs map-by-meaning, de-scrambling, and all 12 v2 concepts", () => {
    const messages = renderTemplate("resume-extract", { rawText: "raw" });
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toMatch(/headline/i);
    expect(joined).toMatch(/YYYY-MM/);
    expect(joined).toMatch(/certification/i);
    expect(joined).toMatch(/language/i);
    expect(joined).toMatch(/project/i);
    expect(joined).toMatch(/sections/i);
    // de-scramble guidance for 2-column PDFs
    expect(joined).toMatch(/two-column|2-column|column/i);
    // name must strip trailing credentials (e.g. ", PMP") out to certifications
    expect(joined).toMatch(/PMP/);
    // headline must never be the summary paragraph
    expect(joined).toMatch(/never.*summary|summary.*never/i);
  });
});

// Seam test (task-1.9, generalizing the B6 evalScores.test.ts pattern to all
// 6 TaskName templates): catches schema/template/contract vocabulary drift
// WITHOUT a real LLM call. For every task whose response schema has a
// closed z.enum, assert the template's prose lists exactly those tokens —
// if either drifts, this fails cheaply instead of a real LLM response
// throwing at runtime and being silently swallowed.
const TEMPLATES: TaskName[] = [
  "resume-extract",
  "jd-extract",
  "match-score",
  "question-extract",
  "question-answer",
  "tailor",
  "correlate",
];

function readTemplateFile(name: TaskName): string {
  return readFileSync(join(process.cwd(), "config", "templates", `${name}.md`), "utf-8");
}

describe("template <-> schema seam (no LLM calls)", () => {
  it("every TaskName has a non-empty template file", () => {
    for (const name of TEMPLATES) {
      expect(readTemplateFile(name).trim().length, `empty template: ${name}`).toBeGreaterThan(0);
    }
  });

  // resume-extract: ResumeStoreSchema (src/server/resume/resume-store.ts) has
  // no z.enum fields — every field is a string/array/object. No closed
  // vocabulary to seam-test; the presence check above suffices.

  // jd-extract: JdFactsSchema (src/server/score/jdFacts.ts) has no z.enum
  // fields either — objective facts only, per the module's own comment. No
  // closed vocabulary to seam-test; presence check suffices.

  it("match-score.md tier prose lists exactly the frozen LegitimacyTier tokens", () => {
    const tierLine = readTemplateFile("match-score").match(/tier: one of([^\n]*)/);
    expect(tierLine).not.toBeNull();
    const tokens = [...tierLine![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(LegitimacyTier.options));
  });

  it("match-score.md verdict prose lists exactly the EvalScoresSchema verdict tokens", () => {
    const verdictLine = readTemplateFile("match-score").match(/verdict of one of([\s\S]*?),/);
    expect(verdictLine).not.toBeNull();
    const tokens = [...verdictLine![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(EvalScoresSchema.shape.verdict.options));
  });

  it("question-extract.md kind prose lists exactly the ApplicationQuestion.kind tokens", () => {
    const kindGroup = readTemplateFile("question-extract").match(/kind \(([\s\S]*?)\)/);
    expect(kindGroup).not.toBeNull();
    const tokens = [...kindGroup![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(ApplicationQuestion.shape.kind.options));
  });

  it("question-answer.md grounding-source prose lists exactly the ApplicationAnswer grounding source tokens", () => {
    const sourceGroup = readTemplateFile("question-answer").match(/from \(([^)]*)\)/);
    expect(sourceGroup).not.toBeNull();
    const tokens = sourceGroup![1].split("|").map((s) => s.trim());
    const sourceOptions = ApplicationAnswer.shape.grounding.element.shape.source.options;
    expect(new Set(tokens)).toEqual(new Set(sourceOptions));
  });

  it("tailor.md operation prose lists exactly the DiffEntrySchema.op tokens", () => {
    const opGroup = readTemplateFile("tailor").match(/operation\s*\(([\s\S]*?)\)/);
    expect(opGroup).not.toBeNull();
    const tokens = [...opGroup![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(DiffEntrySchema.shape.op.options));
  });

  it("correlate.md status prose lists exactly the RequirementStatus tokens", () => {
    const statusGroup = readTemplateFile("correlate").match(/`status`:([\s\S]*?)- `evidence`/);
    expect(statusGroup).not.toBeNull();
    const tokens = [...statusGroup![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(RequirementStatus.options));
  });
});
