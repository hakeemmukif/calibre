import { asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../schema";
import type { Db } from "./db";
import { EmailTakenError } from "@/server/auth/errors";

export type UserRow = typeof users.$inferSelect;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserRepo(db: Db) {
  return {
    async create(input: { email: string; passwordHash: string; role: "user" | "admin" }): Promise<UserRow> {
      const email = normalizeEmail(input.email);
      const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) throw new EmailTakenError(email);
      try {
        const [row] = await db
          .insert(users)
          .values({ email, passwordHash: input.passwordHash, role: input.role })
          .returning();
        return row;
      } catch (err) {
        // drizzle-orm's pg-core session wraps every driver error in a
        // DrizzleQueryError, putting the real driver error (with the
        // Postgres SQLSTATE `.code`) on `.cause` rather than on the
        // thrown error itself — true for both postgres-js and PGlite.
        const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
        if (cause && typeof cause === "object" && (cause as { code?: string }).code === "23505") {
          throw new EmailTakenError(email);
        }
        throw err;
      }
    },
    async findByEmail(email: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
      return row ?? null;
    },
    async findById(id: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
    async list(): Promise<UserRow[]> {
      return db.select().from(users).orderBy(asc(users.createdAt));
    },
  };
}

export const usersRepo: ReturnType<typeof createUserRepo> = {
  create: (i) => createUserRepo(getDb()).create(i),
  findByEmail: (e) => createUserRepo(getDb()).findByEmail(e),
  findById: (i) => createUserRepo(getDb()).findById(i),
  list: () => createUserRepo(getDb()).list(),
};
