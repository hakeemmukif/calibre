// Operator profile repo — singleton row (id "default"), seeded at install
// (seed.ts). Absence is an ERROR (fail loud): scans, scoring and the feed
// all require a profile; there is no in-code default country/relocation.
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { profile } from "../schema";
import type { Db } from "./db";

export type ProfileRow = typeof profile.$inferSelect;

const SINGLETON_ID = "default";

export class ProfileMissingError extends Error {
  constructor() {
    super('profile row "default" is missing — run `npm run db:seed` (the seed is the install step).');
    this.name = "ProfileMissingError";
  }
}

export function createProfileRepo(db: Db) {
  return {
    async get(): Promise<ProfileRow> {
      const [row] = await db.select().from(profile).where(eq(profile.id, SINGLETON_ID)).limit(1);
      if (!row) throw new ProfileMissingError();
      return row;
    },
    async update(input: { baseCountry: string; relocation: "stay" | "open" }): Promise<ProfileRow> {
      const [row] = await db
        .update(profile)
        .set({ baseCountry: input.baseCountry, relocation: input.relocation, updatedAt: sql`now()` })
        .where(eq(profile.id, SINGLETON_ID))
        .returning();
      if (!row) throw new ProfileMissingError();
      return row;
    },
  };
}

export const profileRepo: ReturnType<typeof createProfileRepo> = {
  get: () => createProfileRepo(getDb()).get(),
  update: (input) => createProfileRepo(getDb()).update(input),
};
