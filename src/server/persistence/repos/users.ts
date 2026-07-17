import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { applications, creditLedger, jobs, resumes, users } from "../schema";
import type { Db } from "./db";
import { EmailTakenError } from "@/server/auth/errors";

export type UserRow = typeof users.$inferSelect;

export type AdminUserRow = {
  id: string;
  email: string;
  role: "user" | "admin";
  createdAt: Date;
  resumeCount: number;
  jobCount: number;
  applicationCount: number;
  balance: number;
  plan: "standard" | "unlimited";
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserRepo(db: Db) {
  return {
    // GLOBAL-BY-DECISION: `users` is the auth identity table itself, not a
    // user-owned resource — email-uniqueness must be checked globally,
    // before the new row (and its userId) exists.
    async create(input: { email: string; passwordHash: string; role: "user" | "admin" }): Promise<UserRow> {
      const email = normalizeEmail(input.email);
      const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) throw new EmailTakenError(email);
      try {
        const [row] = await db
          .insert(users)
          .values({ email, passwordHash: input.passwordHash, role: input.role, plan: "standard" as const })
          .returning();
        return row;
      } catch (err) {
        // drizzle wraps driver errors in a "Failed query" error; the libsql
        // unique-violation extendedCode is on the original error at `.cause`.
        const code = (err as { cause?: { extendedCode?: string } })?.cause?.extendedCode;
        if (code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new EmailTakenError(email);
        }
        throw err;
      }
    },
    // GLOBAL-BY-DECISION: auth identity lookup by email — this IS how login
    // resolves a userId in the first place, so there is no userId to scope by.
    async findByEmail(email: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
      return row ?? null;
    },
    // GLOBAL-BY-DECISION: `id` here IS the users.id primary key — the row
    // this looks up is the user, not a resource a user owns, so there is no
    // separate ownership dimension to filter by.
    async findById(id: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
    // GLOBAL-BY-DECISION: admin user list, cross-user by design — this is
    // the identity table itself (not a per-user-owned resource), and the
    // caller is an admin listing every account, not one tenant's rows.
    async list(): Promise<UserRow[]> {
      return db.select().from(users).orderBy(asc(users.createdAt));
    },
    // GLOBAL-BY-DECISION: admin lists every account with counts (not
    // tenant-scoped) — this is the `/api/admin/users` read behind
    // requireAdmin(), a deliberate cross-user dump for the admin surface
    // (plan 2026-07-14-multitenant-admin.md Task 1), not a per-tenant leak.
    async listWithCounts(): Promise<AdminUserRow[]> {
      const allUsers = await db
        .select({ id: users.id, email: users.email, role: users.role, plan: users.plan, createdAt: users.createdAt })
        .from(users)
        .orderBy(asc(users.createdAt));

      const [resumeRows, jobRows, applicationRows, ledgerRows] = await Promise.all([
        db.select({ userId: resumes.userId, count: sql<string>`count(*)` }).from(resumes).groupBy(resumes.userId),
        db.select({ userId: jobs.userId, count: sql<string>`count(*)` }).from(jobs).groupBy(jobs.userId),
        db
          .select({ userId: applications.userId, count: sql<string>`count(*)` })
          .from(applications)
          .groupBy(applications.userId),
        db
          .select({ userId: creditLedger.userId, sum: sql<string>`COALESCE(SUM(${creditLedger.delta}), 0)` })
          .from(creditLedger)
          .groupBy(creditLedger.userId),
      ]);
      const toCountMap = (rows: { userId: string; count: string }[]) =>
        new Map(rows.map((r) => [r.userId, Number(r.count)]));
      const resumeCounts = toCountMap(resumeRows);
      const jobCounts = toCountMap(jobRows);
      const applicationCounts = toCountMap(applicationRows);
      const balanceMap = new Map(ledgerRows.map((r) => [r.userId, Number(r.sum)]));

      return allUsers.map((u) => ({
        ...u,
        resumeCount: resumeCounts.get(u.id) ?? 0,
        jobCount: jobCounts.get(u.id) ?? 0,
        applicationCount: applicationCounts.get(u.id) ?? 0,
        balance: balanceMap.get(u.id) ?? 0,
      }));
    },
    // GLOBAL-BY-DECISION: admin plan toggle — `id` is the users.id primary
    // key, the same identity-table dimension as findById above.
    async updatePlan(id: string, plan: "standard" | "unlimited"): Promise<UserRow> {
      const [row] = await db.update(users).set({ plan }).where(eq(users.id, id)).returning();
      if (!row) throw new Error(`updatePlan: unknown user ${id}`);
      return row;
    },
    // GLOBAL-BY-DECISION: `id` IS the users.id primary key (same dimension
    // as findById). Shared by the operator reset script and the self-serve
    // change-password route (Task 6).
    async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
      const [row] = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
      if (!row) throw new Error(`updatePasswordHash: unknown user ${id}`);
    },
  };
}

export const usersRepo: ReturnType<typeof createUserRepo> = {
  create: (i) => createUserRepo(getDb()).create(i),
  findByEmail: (e) => createUserRepo(getDb()).findByEmail(e),
  findById: (i) => createUserRepo(getDb()).findById(i),
  list: () => createUserRepo(getDb()).list(),
  listWithCounts: () => createUserRepo(getDb()).listWithCounts(),
  updatePlan: (id, plan) => createUserRepo(getDb()).updatePlan(id, plan),
  updatePasswordHash: (id, hash) => createUserRepo(getDb()).updatePasswordHash(id, hash),
};
