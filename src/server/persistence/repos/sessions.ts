import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { sessions, users } from "../schema";
import type { Db } from "./db";
import type { UserRow } from "./users";

// Below this staleness, skip the lastUsedAt UPDATE — every authenticated
// request otherwise queues on SQLite's single writer lock, which stalls
// polling/click traffic behind long-running scan writes.
const LAST_USED_BUMP_MS = 5 * 60_000;

export function createSessionRepo(db: Db) {
  return {
    async create(input: { userId: string; tokenHash: string }): Promise<void> {
      await db.insert(sessions).values({ userId: input.userId, tokenHash: input.tokenHash });
    },
    // GLOBAL-BY-DECISION: auth session resolution — this is how the caller's
    // userId gets determined from an opaque session token; scoping it by
    // userId would be circular. Possession of the raw cookie (whose hash
    // must match) is the authorization boundary.
    async findUserByTokenHash(tokenHash: string): Promise<UserRow | null> {
      const [row] = await db
        .select({ user: users, lastUsedAt: sessions.lastUsedAt })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      if (Date.now() - row.lastUsedAt.getTime() > LAST_USED_BUMP_MS) {
        await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
      }
      return row.user;
    },
    // GLOBAL-BY-DECISION: logout — the token hash itself is the caller's
    // proof of ownership (only the browser holding the raw cookie can
    // present the matching hash); no separate userId scoping applies.
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
