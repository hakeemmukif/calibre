import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { profile } from "../schema";
import { seedProfile } from "../seed";
import { createProfileRepo, ProfileMissingError } from "./profile";

describe("profileRepo", () => {
  it("get() throws ProfileMissingError when the singleton row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.get()).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("get() returns the seeded row", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const repo = createProfileRepo(db);
    const row = await repo.get();
    expect(row.baseCountry).toBe("MY");
    expect(row.relocation).toBe("stay");
  });

  it("update() flips relocation and bumps updatedAt", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const repo = createProfileRepo(db);
    const before = await repo.get();
    const updated = await repo.update({ baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any" });
    expect(updated.relocation).toBe("open");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("update() throws ProfileMissingError when the row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(
      repo.update({ baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any" }),
    ).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("update round-trips both new dials", async () => {
    const db = await createTestDb();
    await seedProfile(db); // seed provides the singleton
    const repo = createProfileRepo(db);
    const row = await repo.update({
      baseCountry: "MY",
      relocation: "open",
      scheduleFlex: "flex-evenings",
      employmentPref: "employee",
    });
    expect(row.scheduleFlex).toBe("flex-evenings");
    expect(row.employmentPref).toBe("employee");
  });

  it("seeded singleton is permissive by default (any-hours / any)", async () => {
    const db = await createTestDb();
    await seedProfile(db);
    const row = await createProfileRepo(db).get();
    expect(row.scheduleFlex).toBe("any-hours");
    expect(row.employmentPref).toBe("any");
  });
});
