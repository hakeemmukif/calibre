import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { profile } from "../schema";
import { createProfileRepo, ProfileMissingError } from "./profile";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("profileRepo", () => {
  it("get() throws ProfileMissingError when the singleton row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.get()).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("get() returns the seeded row", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay" });
    const repo = createProfileRepo(db);
    const row = await repo.get();
    expect(row.baseCountry).toBe("MY");
    expect(row.relocation).toBe("stay");
  });

  it("update() flips relocation and bumps updatedAt", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay" });
    const repo = createProfileRepo(db);
    const before = await repo.get();
    const updated = await repo.update({ baseCountry: "MY", relocation: "open" });
    expect(updated.relocation).toBe("open");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("update() throws ProfileMissingError when the row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.update({ baseCountry: "MY", relocation: "open" })).rejects.toBeInstanceOf(ProfileMissingError);
  });
});
