import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { applications, creditLedger, users } from "../schema";
import { seedAdmin } from "../seed";
import { createUserRepo } from "./users";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { EmailTakenError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("users schema", () => {
  it("migration creates an insertable users table on an empty libsql DB", async () => {
    const db = await createTestDb();
    const [row] = await db
      .insert(users)
      .values({ email: "a@b.co", passwordHash: "x", role: "user", plan: "standard" })
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

  it("users_email_unique constraint fires a SQLITE_CONSTRAINT_UNIQUE on a direct duplicate insert (foundation for the race-safety catch in create())", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user", plan: "standard" });
    await expect(
      db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user", plan: "standard" }),
    ).rejects.toMatchObject({ cause: { extendedCode: "SQLITE_CONSTRAINT_UNIQUE" } });
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

  it("create writes plan 'standard' explicitly; seedAdmin writes 'unlimited'", async () => {
    const db = await createTestDb();
    const repo = createUserRepo(db);
    const u = await repo.create({ email: "p@x.co", passwordHash: "h", role: "user" });
    expect(u.plan).toBe("standard");
    const [admin] = await seedAdmin(db, { email: "root@x.co", password: "hunter2hunter2" });
    expect(admin.plan).toBe("unlimited");
  });

  it("listWithCounts carries plan and a ledger-summed balance, without a per-user query", async () => {
    const db = await createTestDb();
    const repo = createUserRepo(db);
    const a = await repo.create({ email: "ledger-a@x.co", passwordHash: "h", role: "user" });
    const b = await repo.create({ email: "ledger-b@x.co", passwordHash: "h", role: "user" });
    await db.insert(creditLedger).values([
      { userId: a.id, delta: 30, reason: "admin" },
      { userId: a.id, delta: -10, reason: "admin" },
    ]);

    const select = db.select.bind(db);
    let selectCalls = 0;
    db.select = ((...args: Parameters<typeof select>) => {
      selectCalls += 1;
      return select(...args);
    }) as typeof db.select;

    const list = await repo.listWithCounts();
    // allUsers + resumeRows + jobRows + applicationRows + ledgerRows = 5
    // fixed selects, regardless of user count — not one per user (N+1).
    expect(selectCalls).toBe(5);

    const byId = new Map(list.map((u) => [u.id, u]));
    expect(byId.get(a.id)).toMatchObject({ plan: "standard", balance: 20 });
    expect(byId.get(b.id)).toMatchObject({ plan: "standard", balance: 0 });
  });

  it("updatePlan flips the plan and returns the updated row; throws for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createUserRepo(db);
    const u = await repo.create({ email: "toggle@x.co", passwordHash: "h", role: "user" });

    const updated = await repo.updatePlan(u.id, "unlimited");
    expect(updated.plan).toBe("unlimited");
    expect((await repo.findById(u.id))?.plan).toBe("unlimited");

    await expect(repo.updatePlan(crypto.randomUUID(), "standard")).rejects.toThrow();
  });

  it("updatePasswordHash swaps the hash; unknown id throws (fail loud)", async () => {
    const db = await createTestDb();
    const repo = createUserRepo(db);
    const u = await repo.create({ email: "pw@x.co", passwordHash: "old-hash", role: "user" });
    await repo.updatePasswordHash(u.id, "new-hash");
    expect((await repo.findById(u.id))?.passwordHash).toBe("new-hash");
    await expect(repo.updatePasswordHash("nope", "h")).rejects.toThrow("updatePasswordHash: unknown user nope");
  });
});
