import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { applications, users } from "../schema";
import { createUserRepo } from "./users";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { EmailTakenError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("users schema", () => {
  it("migration creates an insertable users table on an empty PGlite DB", async () => {
    const db = await createTestDb();
    const [row] = await db
      .insert(users)
      .values({ email: "a@b.co", passwordHash: "x", role: "user" })
      .returning();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.role).toBe("user");
  });
});

describe("usersRepo", () => {
  it("create() normalizes email to lowercase and findByEmail is case-insensitive", async () => {
    const repo = createUserRepo(await createTestDb());
    const u = await repo.create({ email: "Alex@Example.COM", passwordHash: "h", role: "user" });
    expect(u.email).toBe("alex@example.com");
    expect((await repo.findByEmail("alex@EXAMPLE.com"))?.id).toBe(u.id);
  });

  it("create() throws EmailTakenError on duplicate (normalized) email", async () => {
    const repo = createUserRepo(await createTestDb());
    await repo.create({ email: "dup@x.co", passwordHash: "h", role: "user" });
    await expect(repo.create({ email: "DUP@x.co", passwordHash: "h", role: "user" }))
      .rejects.toBeInstanceOf(EmailTakenError);
  });

  it("users_email_unique constraint fires a 23505 on a direct duplicate insert (foundation for the race-safety catch in create())", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user" });
    await expect(
      db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("findById returns the row; list() returns all (including the migration-seeded admin)", async () => {
    const repo = createUserRepo(await createTestDb());
    const a = await repo.create({ email: "a@x.co", passwordHash: "h", role: "admin" });
    const b = await repo.create({ email: "b@x.co", passwordHash: "h", role: "user" });
    expect((await repo.findById(a.id))?.role).toBe("admin");
    const list = await repo.list();
    expect(list.length).toBe(3);
    expect(list.map((u) => u.id).sort()).toEqual([BOOTSTRAP_ADMIN_ID, a.id, b.id].sort());
  });

  it("listWithCounts returns every user with correct, per-user resume/job/application counts and no passwordHash", async () => {
    const db = await createTestDb();
    const repo = createUserRepo(db);
    const a = await repo.create({ email: "a@x.co", passwordHash: "h", role: "user" });
    const b = await repo.create({ email: "b@x.co", passwordHash: "h", role: "user" });
    const source = await insertSource(db);

    // A: 2 résumés, 1 job, 1 application. B: 1 résumé, 2 jobs, 0 applications.
    await insertResume(db, { userId: a.id, isActive: true });
    await insertResume(db, { userId: a.id, isActive: false });
    const aJob = await insertJob(db, source.id, { userId: a.id });
    const aResume = await insertResume(db, { userId: a.id, isActive: false });
    await db.insert(applications).values({
      userId: a.id,
      jobId: aJob.id,
      resumeId: aResume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "neutral",
      note: "",
    });

    await insertResume(db, { userId: b.id, isActive: true });
    await insertJob(db, source.id, { userId: b.id });
    await insertJob(db, source.id, { userId: b.id });

    const list = await repo.listWithCounts();
    expect(list.length).toBe(3); // bootstrap admin + a + b

    const byId = new Map(list.map((u) => [u.id, u]));
    expect(byId.get(a.id)).toMatchObject({ resumeCount: 3, jobCount: 1, applicationCount: 1 });
    expect(byId.get(b.id)).toMatchObject({ resumeCount: 1, jobCount: 2, applicationCount: 0 });
    expect(byId.get(BOOTSTRAP_ADMIN_ID)).toMatchObject({ resumeCount: 0, jobCount: 0, applicationCount: 0 });

    for (const u of list) {
      expect(u).not.toHaveProperty("passwordHash");
    }
  });
});
