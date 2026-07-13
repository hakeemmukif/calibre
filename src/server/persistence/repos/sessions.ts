import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { sessions, users } from "../schema";
import type { Db } from "./db";
import type { UserRow } from "./users";

export function createSessionRepo(db: Db) {
  return {
    async create(input: { userId: string; tokenHash: string }): Promise<void> {
      await db.insert(sessions).values({ userId: input.userId, tokenHash: input.tokenHash });
    },
    async findUserByTokenHash(tokenHash: string): Promise<UserRow | null> {
      const [row] = await db
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      await db.update(sessions).set({ lastUsedAt: sql`now()` }).where(eq(sessions.tokenHash, tokenHash));
      return row.user;
    },
    async deleteByTokenHash(tokenHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
  };
}

export const sessionsRepo: ReturnType<typeof createSessionRepo> = {
  create: (i) => createSessionRepo(getDb()).create(i),
  findUserByTokenHash: (t) => createSessionRepo(getDb()).findUserByTokenHash(t),
  deleteByTokenHash: (t) => createSessionRepo(getDb()).deleteByTokenHash(t),
};
