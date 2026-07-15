// Deterministic fixture-validity gate for the golden set eval.live.test.ts
// runs against. NO LLM — runs in the normal `npm test` gate so a malformed
// golden (bad ResumeStore/JdFacts shape, malformed `expected.rows`) fails
// CI immediately instead of only surfacing when the operator next runs the
// costly `npm run eval:tailor`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResumeStoreSchema } from "@/server/resume/resume-store";
import { JdFactsSchema } from "@/server/score/jdFacts";

const DIR = join(__dirname, "__fixtures__", "golden");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("tailor correlation golden fixtures", () => {
  it("has at least 3 goldens", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s: resume is a valid ResumeStore, jdFacts is valid JdFacts, expected.rows is well-formed", (file) => {
    const golden = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    expect(typeof golden.id).toBe("string");
    expect(["real", "synthetic"]).toContain(golden.category);

    expect(() => ResumeStoreSchema.parse(golden.resume)).not.toThrow();
    expect(() => JdFactsSchema.parse(golden.jdFacts)).not.toThrow();

    expect(Array.isArray(golden.expected?.rows)).toBe(true);
    expect(golden.expected.rows.length).toBeGreaterThan(0);
    for (const row of golden.expected.rows) {
      expect(typeof row.requirement).toBe("string");
      expect(row.requirement.length).toBeGreaterThan(0);
      expect(["met", "buried", "gap"]).toContain(row.status);
    }
  });
});
