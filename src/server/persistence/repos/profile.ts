// Per-user profile repo (Step 3 task 1): every operator/registrant has their
// own row, enforced by the `profile_user_id_unique` constraint
// (schema.ts:96). Absence is an ERROR (fail loud) for get/update: scans,
// scoring and the feed all require a profile; there is no in-code default
// country/relocation. `upsert` is the onboarding path — a fresh registrant
// has no row yet, so PUT /api/profile must create-or-replace, not just
// replace.
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { profile } from "../schema";
import type { Db } from "./db";

export type ProfileRow = typeof profile.$inferSelect;

export type ProfileInput = {
  baseCountry: string;
  relocation: "stay" | "open";
  scheduleFlex: "base-hours" | "flex-evenings" | "any-hours";
  employmentPref: "any" | "employee" | "local-entity";
};

export class ProfileMissingError extends Error {
  constructor() {
    super("profile row is missing for this user — PUT /api/profile to create one (onboarding).");
    this.name = "ProfileMissingError";
  }
}

export function createProfileRepo(db: Db) {
  return {
    async get(userId: string): Promise<ProfileRow> {
      const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
      if (!row) throw new ProfileMissingError();
      return row;
    },
    async update(userId: string, input: ProfileInput): Promise<ProfileRow> {
      const [row] = await db
        .update(profile)
        .set({
          baseCountry: input.baseCountry, relocation: input.relocation,
          scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
          updatedAt: new Date(),
        })
        .where(eq(profile.userId, userId))
        .returning();
      if (!row) throw new ProfileMissingError();
      return row;
    },
    // Insert-or-update keyed on the `profile_user_id_unique` constraint
    // (NOT profile.id — the seeded admin row already has id="default", so
    // targeting id would raise a unique violation on user_id the first time
    // the admin upserts). `id` is cosmetic on insert.
    async upsert(userId: string, input: ProfileInput): Promise<ProfileRow> {
      const [row] = await db
        .insert(profile)
        .values({
          id: crypto.randomUUID(), userId,
          baseCountry: input.baseCountry, relocation: input.relocation,
          scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
        })
        .onConflictDoUpdate({
          target: profile.userId,
          set: {
            baseCountry: input.baseCountry, relocation: input.relocation,
            scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },
  };
}

export const profileRepo: ReturnType<typeof createProfileRepo> = {
  get: (userId) => createProfileRepo(getDb()).get(userId),
  update: (userId, input) => createProfileRepo(getDb()).update(userId, input),
  upsert: (userId, input) => createProfileRepo(getDb()).upsert(userId, input),
};
