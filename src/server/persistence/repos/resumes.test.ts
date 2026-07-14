import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { resumes, users } from "../schema";
import { createResumesRepo } from "./resumes";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("resumesRepo", () => {
  it("round-trips insertReplacingActive → getActive", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const inserted = await repo.insertReplacingActive({
      userId: BOOTSTRAP_ADMIN_ID,
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
    const active = await repo.getActive(BOOTSTRAP_ADMIN_ID);
    expect(active?.id).toBe(inserted.id);
    expect(active?.rawText).toBe("raw text");
  });

  it("supersedes the previously-active résumé", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const base = {
      userId: BOOTSTRAP_ADMIN_ID,
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

    const active = await repo.getActive(BOOTSTRAP_ADMIN_ID);
    expect(active?.id).toBe(b.id);
    expect(active?.rawText).toBe("resume B");

    const rows = await db.select().from(resumes);
    const aAfter = rows.find((r) => r.id === a.id);
    expect(aAfter?.isActive).toBe(false);
  });

  it("does not deactivate another user's active résumé when superseding (cross-tenant isolation)", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-resumes@example.com", passwordHash: "h", role: "user" })
      .returning();

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

    const resumeA = await repo.insertReplacingActive({ ...base, userId: BOOTSTRAP_ADMIN_ID, rawText: "resume A" });
    const resumeB = await repo.insertReplacingActive({ ...base, userId: userB.id, rawText: "resume B" });

    const rows = await db.select().from(resumes);
    const aAfter = rows.find((r) => r.id === resumeA.id);
    const bAfter = rows.find((r) => r.id === resumeB.id);

    expect(aAfter?.isActive).toBe(true);
    expect(bAfter?.isActive).toBe(true);

    const activeForA = rows.filter((r) => r.userId === BOOTSTRAP_ADMIN_ID && r.isActive);
    const activeForB = rows.filter((r) => r.userId === userB.id && r.isActive);
    expect(activeForA).toHaveLength(1);
    expect(activeForB).toHaveLength(1);
  });

  it("getById fetches a non-active résumé by id, and returns null for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const a = await repo.insertReplacingActive({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: "resume A",
      structured: { name: "A", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });
    await repo.insertReplacingActive({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: "resume B",
      structured: { name: "B", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });

    const found = await repo.getById(a.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.rawText).toBe("resume A");
    expect(found?.isActive).toBe(false);

    expect(await repo.getById("00000000-0000-0000-0000-000000000000", BOOTSTRAP_ADMIN_ID)).toBeNull();
  });

  it("getActive(userId) is invisible to a different user (cross-tenant isolation)", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-resumes-getactive@example.com", passwordHash: "h", role: "user" })
      .returning();

    await repo.insertReplacingActive({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: "resume A",
      structured: { name: "A", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });

    expect(await repo.getActive(userB.id)).toBeNull();
  });

  it("getById(id, userId) returns null for a foreign-owned résumé (no existence leak)", async () => {
    const db = await createTestDb();
    const repo = createResumesRepo(db);

    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-resumes-getbyid@example.com", passwordHash: "h", role: "user" })
      .returning();

    const resumeA = await repo.insertReplacingActive({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: "resume A",
      structured: { name: "A", contact: [], summary: "s", experience: [], education: [], skills: [], extras: [] },
      sourceKind: "paste",
      isActive: true,
    });

    expect(await repo.getById(resumeA.id, userB.id)).toBeNull();
  });
});
