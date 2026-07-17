import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { postings } from "../schema";
import type { Db } from "./db";
import { insertSource } from "./__fixtures__/helpers";
import { createPostingsRepo, listForMatchingProjection, type NewPosting } from "./postings";

let counter = 0;
async function insertPosting(db: Db, sourceId: string, overrides: Partial<NewPosting> = {}) {
  counter += 1;
  const key = `ck-${counter}`;
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

describe("postingsRepo", () => {
  describe("listForMatching projection (arch §1.2 — the read-amplification pin)", () => {
    it("query text OMITS description and INCLUDES department", async () => {
      const db = await createTestDb();
      const { sql } = db.select(listForMatchingProjection).from(postings).toSQL();
      const lower = sql.toLowerCase();
      // Hard constraint: a stage-1 scan must never drag the ~4.3 KB JD column.
      expect(lower).not.toContain("description");
      // P.4's tag input rides the projection (short string, no amplification).
      expect(lower).toContain("department");
    });

    it("also structurally omits the json blobs raw and aliases", async () => {
      const db = await createTestDb();
      const { sql } = db.select(listForMatchingProjection).from(postings).toSQL();
      const lower = sql.toLowerCase();
      expect(lower).not.toContain("aliases");
      expect(lower).not.toContain('"raw"');
    });
  });

  describe("listForMatching filtering", () => {
    it("returns live rows only and persona-scopes (remote sees remote+both, not local)", async () => {
      const db = await createTestDb();
      const repo = createPostingsRepo(db);
      const source = await insertSource(db);

      const remote = await insertPosting(db, source.id, { persona: "remote" });
      const both = await insertPosting(db, source.id, { persona: "both" });
      await insertPosting(db, source.id, { persona: "local" });
      await insertPosting(db, source.id, { persona: "remote", delistedAt: new Date() });

      const rows = await repo.listForMatching("remote");
      expect(rows.map((r) => r.id).sort()).toEqual([remote.id, both.id].sort());
    });

    it("local scan sees local+both, not remote", async () => {
      const db = await createTestDb();
      const repo = createPostingsRepo(db);
      const source = await insertSource(db);
      const local = await insertPosting(db, source.id, { persona: "local" });
      const both = await insertPosting(db, source.id, { persona: "both" });
      await insertPosting(db, source.id, { persona: "remote" });

      const rows = await repo.listForMatching("local");
      expect(rows.map((r) => r.id).sort()).toEqual([local.id, both.id].sort());
    });
  });

  describe("canonicalKey uniqueness", () => {
    it("rejects a second row with the same canonicalKey", async () => {
      const db = await createTestDb();
      const source = await insertSource(db);
      await insertPosting(db, source.id, { canonicalKey: "dup" });
      await expect(insertPosting(db, source.id, { canonicalKey: "dup" })).rejects.toMatchObject({
        cause: { extendedCode: "SQLITE_CONSTRAINT_UNIQUE" },
      });
    });
  });

  describe("getForScoring", () => {
    it("includes description for the requested ids; empty input is a no-op", async () => {
      const db = await createTestDb();
      const repo = createPostingsRepo(db);
      const source = await insertSource(db);
      const p = await insertPosting(db, source.id, { description: "Full JD text here." });

      expect(await repo.getForScoring([])).toEqual([]);
      const rows = await repo.getForScoring([p.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe("Full JD text here.");
    });
  });

  describe("setFunctionTag (P.4 write-back cache)", () => {
    it("persists tag + version, and throws on an unknown id", async () => {
      const db = await createTestDb();
      const repo = createPostingsRepo(db);
      const source = await insertSource(db);
      const p = await insertPosting(db, source.id);
      expect(p.functionTag).toBeNull();

      await repo.setFunctionTag(p.id, "engineering", "fc-v1");
      const [refetched] = await repo.getForScoring([p.id]);
      expect(refetched.functionTag).toBe("engineering");
      expect(refetched.functionTagVersion).toBe("fc-v1");

      await expect(repo.setFunctionTag("nope", "x", "fc-v1")).rejects.toThrow(/no posting/);
    });
  });
});
