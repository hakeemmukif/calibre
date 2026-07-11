import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { resumes } from "../schema";
import { createResumesRepo } from "./resumes";

describe("resumesRepo", () => {
  it("round-trips insertReplacingActive → getActive", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const inserted = await repo.insertReplacingActive({
      rawText: "raw text",
      structured: {
        name: "Jane Doe",
        contact: [],
        summary: "summary",
        experience: [],
        education: [],
        skills: [],
        extras: [],
      },
      sourceKind: "paste",
      isActive: true,
    });

    expect(inserted.isActive).toBe(true);
    const active = await repo.getActive();
    expect(active?.id).toBe(inserted.id);
    expect(active?.rawText).toBe("raw text");
  });

  it("supersedes the previously-active résumé", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const base = {
      structured: {
        name: "A",
        contact: [],
        summary: "s",
        experience: [],
        education: [],
        skills: [],
        extras: [],
      },
      sourceKind: "paste" as const,
      isActive: true,
    };

    const a = await repo.insertReplacingActive({ ...base, rawText: "resume A" });
    const b = await repo.insertReplacingActive({ ...base, rawText: "resume B" });

    const active = await repo.getActive();
    expect(active?.id).toBe(b.id);
    expect(active?.rawText).toBe("resume B");

    const rows = await db.select().from(resumes);
    const aAfter = rows.find((r) => r.id === a.id);
    expect(aAfter?.isActive).toBe(false);
  });

  it("getById fetches a non-active résumé by id, and returns null for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const a = await repo.insertReplacingActive({
      rawText: "resume A",
      structured: { name: "A", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });
    await repo.insertReplacingActive({
      rawText: "resume B",
      structured: { name: "B", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });

    const found = await repo.getById(a.id);
    expect(found?.rawText).toBe("resume A");
    expect(found?.isActive).toBe(false);

    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
