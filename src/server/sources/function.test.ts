import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { postings } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { NewPosting } from "@/server/persistence/repos/postings";
import type { Db } from "@/server/persistence/repos/db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const {
  FUNCTION_TAGS,
  FUNCTION_CLASSIFIER_VERSION,
  resolveFunctionTag,
  classifyFunctionTag,
  ensureFunctionTag,
} = await import("./function");
const { postingsRepo } = await import("@/server/persistence/repos/postings");

let counter = 0;
async function insertPosting(db: Db, sourceId: string, overrides: Partial<NewPosting> = {}) {
  counter += 1;
  const key = `fn-ck-${counter}`;
  const [row] = await db
    .insert(postings)
    .values({
      canonicalKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Senior Backend Engineer",
      company: "Example Co",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

describe("resolveFunctionTag (deterministic two-tier resolution)", () => {
  it("resolves from department when it maps to a known function", () => {
    expect(resolveFunctionTag({ department: "Engineering", title: "Anything" })).toBe("engineering");
    expect(resolveFunctionTag({ department: "Sales", title: "Anything" })).toBe("sales");
  });

  it("falls back to title when department is absent", () => {
    expect(resolveFunctionTag({ department: null, title: "Senior Backend Engineer" })).toBe("engineering");
    expect(resolveFunctionTag({ department: "", title: "Account Executive" })).toBe("sales");
  });

  it("falls back to title when department is present but unmapped", () => {
    expect(resolveFunctionTag({ department: "Team Rocket", title: "Product Designer" })).toBe("design");
  });

  it("returns null (residue) when neither tier resolves", () => {
    expect(resolveFunctionTag({ department: null, title: "Zone General Manager" })).toBeNull();
  });
});

// Spot-check accuracy sample: hand-labeled against the actual title text (not
// tuned to force a pass — each label is the obvious real-world function for
// that title). Titles pulled from the live-titles.json corpus below.
const HAND_LABELED_SAMPLE: [string, (typeof FUNCTION_TAGS)[number]][] = [
  ["Account Executive - Italy", "sales"],
  ["AI Engineer", "engineering"],
  ["Business Development Representative ", "sales"],
  ["Senior Technical Recruiter (Global)", "people"],
  ["Talent Acquisition Partner ", "people"],
  ["Head of Marketing, Southeast Asia", "marketing"],
  ["Global Compliance Manager", "legal"],
  ["Corporate Legal Counsel, France", "legal"],
  ["Manager, Customer Success", "customer-success"],
  ["Product Designer, Stablecoin", "design"],
  ["Visual Designer", "design"],
  ["Machine Learning Engineer, Radar", "data"],
  ["Senior Product Manager, Identity & Authentication", "product"],
  ["Business Operations Associate", "operations"],
  ["Executive Assistant ", "executive"],
  ["Head of / Senior Director of FP&A", "finance"],
];

describe("resolveFunctionTag accuracy — hand-labeled spot sample", () => {
  it("matches the hand-labeled expectation for every sampled title", () => {
    const results = HAND_LABELED_SAMPLE.map(
      ([title, expected]) => [title, expected, resolveFunctionTag({ department: null, title })] as const,
    );
    const wrong = results.filter(([, expected, actual]) => actual !== expected);
    expect(wrong, `mismatches: ${JSON.stringify(wrong)}`).toEqual([]);
  });
});

// Measured band size over the real corpus (arch §3.3 / plan P.4: "report the
// measured band size"). live-titles.json predates department plumbing (P.3) —
// every row has no `department` field — so this measures the title-fallback
// tier's coverage alone, the harder of the two tiers. Residue (neither tier
// resolves) is the band that would need the LLM tier in production.
describe("measured residue band over live-titles.json", () => {
  const fixturePath = join(
    process.cwd(),
    "src/server/search/__fixtures__/live-titles.json",
  );
  const liveTitles = JSON.parse(readFileSync(fixturePath, "utf-8")) as { title: string }[];

  it("resolves the large majority of the real corpus without any LLM call", () => {
    expect(liveTitles.length).toBeGreaterThan(2000);
    const residue = liveTitles.filter((row) => resolveFunctionTag({ department: null, title: row.title }) === null);
    const residueRatio = residue.length / liveTitles.length;
    // Measured 2026-07-17: 308/2906 (~10.6%) residue. Pinned as "a small band,
    // not every posting" (plan P.4) rather than an exact count, so an
    // unrelated future title added to the fixture doesn't flake this test.
    expect(residueRatio).toBeLessThan(0.2);
    // eslint-disable-next-line no-console
    console.log(`function.test.ts: measured residue ${residue.length}/${liveTitles.length} (${(residueRatio * 100).toFixed(1)}%)`);
  });
});

describe("classifyFunctionTag (LLM tier) — fail loud on emission drift", () => {
  const input = { title: "Enablement Lead, EMEA", department: null };

  it("returns the tag on a well-formed response", async () => {
    const llm = makeMockLlm({ "function-classify": { functionTag: "sales" } });
    await expect(classifyFunctionTag(input, llm)).resolves.toBe("sales");
  });

  it("throws when the model omits the required functionTag field (schema-required lesson)", async () => {
    const llm = makeMockLlm({ "function-classify": {} });
    await expect(classifyFunctionTag(input, llm)).rejects.toThrow();
  });

  it("throws when the model emits a tag outside the closed FUNCTION_TAGS enum", async () => {
    const llm = makeMockLlm({ "function-classify": { functionTag: "operations-adjacent" } });
    await expect(classifyFunctionTag(input, llm)).rejects.toThrow();
  });
});

describe("ensureFunctionTag (write-back cache + classifier-version re-tag gate)", () => {
  it("resolves deterministically, persists via setFunctionTag, and never calls the LLM", async () => {
    state.testDb = await createTestDb();
    const source = await insertSource(state.testDb);
    const row = await insertPosting(state.testDb, source.id, { title: "Senior Backend Engineer", department: null });
    const llm = makeMockLlm(() => {
      throw new Error("LLM must not be called for a deterministically-resolved posting");
    });

    const tag = await ensureFunctionTag(
      { id: row.id, title: row.title, department: row.department, functionTag: row.functionTag, functionTagVersion: row.functionTagVersion },
      { llm },
    );

    expect(tag).toBe("engineering");
    const [persisted] = await postingsRepo.getForScoring([row.id]);
    expect(persisted.functionTag).toBe("engineering");
    expect(persisted.functionTagVersion).toBe(FUNCTION_CLASSIFIER_VERSION);
  });

  it("classifies residue via the LLM and persists the verdict", async () => {
    state.testDb = await createTestDb();
    const source = await insertSource(state.testDb);
    const row = await insertPosting(state.testDb, source.id, { title: "Zone General Manager", department: null });
    const llm = makeMockLlm({ "function-classify": { functionTag: "operations" } });

    const tag = await ensureFunctionTag(
      { id: row.id, title: row.title, department: row.department, functionTag: row.functionTag, functionTagVersion: row.functionTagVersion },
      { llm },
    );

    expect(tag).toBe("operations");
    const [persisted] = await postingsRepo.getForScoring([row.id]);
    expect(persisted.functionTag).toBe("operations");
    expect(persisted.functionTagVersion).toBe(FUNCTION_CLASSIFIER_VERSION);
  });

  it("reads the cache and skips both resolution and the LLM when the version matches", async () => {
    state.testDb = await createTestDb();
    const source = await insertSource(state.testDb);
    const row = await insertPosting(state.testDb, source.id, {
      title: "Senior Backend Engineer",
      functionTag: "sales", // deliberately "wrong" — proves the cache wins, not fresh resolution
      functionTagVersion: FUNCTION_CLASSIFIER_VERSION,
    });
    const llm = makeMockLlm(() => {
      throw new Error("LLM must not be called when the cache is current");
    });

    const tag = await ensureFunctionTag(
      { id: row.id, title: row.title, department: row.department, functionTag: row.functionTag, functionTagVersion: row.functionTagVersion },
      { llm },
    );

    expect(tag).toBe("sales");
  });

  it("re-tags on a classifier-version bump instead of trusting a stale cache", async () => {
    state.testDb = await createTestDb();
    const source = await insertSource(state.testDb);
    const row = await insertPosting(state.testDb, source.id, {
      title: "Senior Backend Engineer",
      functionTag: "sales", // stale verdict from a hypothetical older classifier version
      functionTagVersion: "fc-v0",
    });
    const llm = makeMockLlm(() => {
      throw new Error("LLM must not be called — this title resolves deterministically");
    });

    const tag = await ensureFunctionTag(
      { id: row.id, title: row.title, department: row.department, functionTag: row.functionTag, functionTagVersion: row.functionTagVersion },
      { llm },
    );

    expect(tag).toBe("engineering");
    const [persisted] = await postingsRepo.getForScoring([row.id]);
    expect(persisted.functionTag).toBe("engineering");
    expect(persisted.functionTagVersion).toBe(FUNCTION_CLASSIFIER_VERSION);
  });
});
