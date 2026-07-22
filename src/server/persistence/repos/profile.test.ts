import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { profile, users } from "../schema";
import { createProfileRepo, ProfileMissingError } from "./profile";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

async function insertSecondUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [userB] = await db
    .insert(users)
    .values({ email: "user-b-profile@example.com", passwordHash: "h", role: "user", plan: "standard" })
    .returning();
  return userB.id;
}

describe("profileRepo", () => {
  it("get(userId) throws ProfileMissingError when that user has no row", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.get(BOOTSTRAP_ADMIN_ID)).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("get(userId) returns that user's row", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
    });
    const repo = createProfileRepo(db);
    const row = await repo.get(BOOTSTRAP_ADMIN_ID);
    expect(row.baseCountry).toBe("MY");
    expect(row.relocation).toBe("stay");
  });

  it("two users' profiles are independent (cross-tenant isolation)", async () => {
    const db = await createTestDb();
    const userBId = await insertSecondUser(db);
    await db.insert(profile).values([
      { id: "p-admin", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
      { id: "p-userb", userId: userBId, baseCountry: "SG", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any" },
    ]);
    const repo = createProfileRepo(db);

    const admin = await repo.get(BOOTSTRAP_ADMIN_ID);
    const userB = await repo.get(userBId);
    expect(admin.baseCountry).toBe("MY");
    expect(userB.baseCountry).toBe("SG");

    await expect(
      repo.update(userBId, {
        baseCountry: "US", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    ).resolves.toMatchObject({ baseCountry: "US" });
    const adminAfter = await repo.get(BOOTSTRAP_ADMIN_ID);
    expect(adminAfter.baseCountry).toBe("MY"); // unaffected by userB's update
  });

  it("update(userId) flips relocation and bumps updatedAt", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
    });
    const repo = createProfileRepo(db);
    const before = await repo.get(BOOTSTRAP_ADMIN_ID);
    const updated = await repo.update(BOOTSTRAP_ADMIN_ID, {
      baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    expect(updated.relocation).toBe("open");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("update(userId) throws ProfileMissingError when that user has no row", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(
      repo.update(BOOTSTRAP_ADMIN_ID, {
        baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    ).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("update(userId) sets scheduleFlex and employmentPref", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
    });
    const repo = createProfileRepo(db);
    const updated = await repo.update(BOOTSTRAP_ADMIN_ID, {
      baseCountry: "MY", relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "employee",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    expect(updated.scheduleFlex).toBe("flex-evenings");
    expect(updated.employmentPref).toBe("employee");
  });

  it("upsert() creates a row for a user with none, then updates it on a second call", async () => {
    const db = await createTestDb();
    const userBId = await insertSecondUser(db);
    const repo = createProfileRepo(db);

    const created = await repo.upsert(userBId, {
      baseCountry: "SG", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    expect(created.userId).toBe(userBId);
    expect(created.baseCountry).toBe("SG");

    const updated = await repo.upsert(userBId, {
      baseCountry: "SG", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    expect(updated.id).toBe(created.id); // same row, not a duplicate
    expect(updated.relocation).toBe("open");

    const rows = await db.select().from(profile);
    expect(rows.filter((r) => r.userId === userBId)).toHaveLength(1);
  });

  it("the seeded admin's first upsert() does not raise a unique violation (conflict-target regression guard)", async () => {
    // schema.ts's seed migration already inserts a profile row with
    // id="default", userId=BOOTSTRAP_ADMIN_ID — the trap this guards against
    // is targeting profile.id instead of profile.userId in onConflictDoUpdate,
    // which would try to insert a second row with the SAME id ("default")
    // and raise a unique violation on user_id instead of updating in place.
    const db = await createTestDb();
    await db.insert(profile).values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
    });
    const repo = createProfileRepo(db);

    const result = await repo.upsert(BOOTSTRAP_ADMIN_ID, {
      baseCountry: "SG", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    expect(result.id).toBe("default");
    expect(result.baseCountry).toBe("SG");

    const rows = await db.select().from(profile);
    expect(rows.filter((r) => r.userId === BOOTSTRAP_ADMIN_ID)).toHaveLength(1);
  });

  it("upsert() for two different users never conflicts with each other", async () => {
    const db = await createTestDb();
    const userBId = await insertSecondUser(db);
    const repo = createProfileRepo(db);

    await repo.upsert(BOOTSTRAP_ADMIN_ID, {
      baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });
    await repo.upsert(userBId, {
      baseCountry: "SG", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
    });

    const rows = await db.select().from(profile);
    expect(rows).toHaveLength(2);
  });
});
