import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./test-db";
import { users, profile, jobs, resumes, sources } from "./schema";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const ADMIN = BOOTSTRAP_ADMIN_ID;

describe("0009 user_id migration (empty-DB replay)", () => {
  it("seeds the bootstrap admin so the backfill FK has a target", async () => {
    const db = await createTestDb();
    const [a] = await db.select().from(users).where(eq(users.id, ADMIN));
    expect(a?.role).toBe("admin");
  });

  it("profile enforces UNIQUE(user_id)", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "p1", userId: ADMIN, baseCountry: "MY", relocation: "stay" });
    await expect(
      db.insert(profile).values({ id: "p2", userId: ADMIN, baseCountry: "MY", relocation: "stay" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("resumes allows one active per user, rejects a second (partial unique)", async () => {
    const db = await createTestDb();
    const base = { userId: ADMIN, rawText: "x", structured: {} as never, sourceKind: "paste" as const };
    await db.insert(resumes).values({ ...base, isActive: true });
    await db.insert(resumes).values({ ...base, isActive: false }); // inactive is fine
    await expect(db.insert(resumes).values({ ...base, isActive: true })).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("jobs dedupe is per-user: same dedupe_key under one user conflicts", async () => {
    const db = await createTestDb();
    const [source] = await db
      .insert(sources)
      .values({
        id: "source-1",
        name: "Test Source",
        kind: "ats",
        persona: "remote",
        enabled: true,
        config: { geo: { scope: "restricted" } },
      })
      .returning();

    const base = {
      userId: ADMIN,
      dedupeKey: "dk-1",
      url: "https://example.com/1",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote" as const,
      eligibility: "unknown" as const,
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    };

    await db.insert(jobs).values(base);
    await expect(db.insert(jobs).values(base)).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
