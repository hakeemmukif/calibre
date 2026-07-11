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
});
