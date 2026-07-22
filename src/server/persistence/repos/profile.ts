// Per-user profile repo (Step 3 task 1): every operator/registrant has their
// own row, enforced by the `profile_user_id_unique` constraint
// (schema.ts:96). Absence is an ERROR (fail loud) for get/update: scans,
// scoring and the feed all require a profile; there is no in-code default
// country/relocation. `upsert` is the onboarding path — a fresh registrant
// has no row yet, so PUT /api/profile must create-or-replace, not just
// replace.
import { eq } from "drizzle-orm";
import type { AttrProvenance } from "@/types";
import { getDb } from "../db";
import { profile } from "../schema";
import type { Db } from "./db";

export type ProfileRow = typeof profile.$inferSelect;

export type ProfileInput = {
  baseCountry: string;
  relocation: "stay" | "open";
  scheduleFlex: "base-hours" | "flex-evenings" | "any-hours";
  employmentPref: "any" | "employee" | "local-entity";
  displayLocation: string | null;
  targetRole: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryCadence: "monthly" | "annual" | null;
};

export class ProfileMissingError extends Error {
  constructor() {
    super("profile row is missing for this user — PUT /api/profile to create one (onboarding).");
    this.name = "ProfileMissingError";
  }
}

// Sticky provenance (spec §6): a PUT that changes an attribute's value marks
// that attribute (or, for salary, the four-field unit as one) "user"-owned —
// permanently, since seedFromResume below refuses to touch "user" fields.
// Unchanged values must NOT flip an existing "resume" stamp to "user".
function stampProvenance(existing: ProfileRow | undefined, input: ProfileInput): AttrProvenance {
  if (!existing) {
    const prov: AttrProvenance = {};
    if (input.displayLocation !== null) prov.displayLocation = "user";
    if (input.targetRole !== null) prov.targetRole = "user";
    if (input.salaryMin !== null || input.salaryMax !== null || input.salaryCurrency !== null || input.salaryCadence !== null)
      prov.salary = "user";
    return prov;
  }
  const prov: AttrProvenance = { ...existing.attrProvenance };
  if (input.displayLocation !== existing.displayLocation) prov.displayLocation = "user";
  if (input.targetRole !== existing.targetRole) prov.targetRole = "user";
  if (
    input.salaryMin !== existing.salaryMin ||
    input.salaryMax !== existing.salaryMax ||
    input.salaryCurrency !== existing.salaryCurrency ||
    input.salaryCadence !== existing.salaryCadence
  )
    prov.salary = "user";
  return prov;
}

export function createProfileRepo(db: Db) {
  return {
    async get(userId: string): Promise<ProfileRow> {
      const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
      if (!row) throw new ProfileMissingError();
      return row;
    },
    async update(userId: string, input: ProfileInput): Promise<ProfileRow> {
      const [existing] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
      if (!existing) throw new ProfileMissingError();
      const [row] = await db
        .update(profile)
        .set({
          baseCountry: input.baseCountry, relocation: input.relocation,
          scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
          displayLocation: input.displayLocation, targetRole: input.targetRole,
          salaryMin: input.salaryMin, salaryMax: input.salaryMax,
          salaryCurrency: input.salaryCurrency, salaryCadence: input.salaryCadence,
          attrProvenance: stampProvenance(existing, input),
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
      const [existing] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
      const prov = stampProvenance(existing, input);
      const [row] = await db
        .insert(profile)
        .values({
          id: crypto.randomUUID(), userId,
          baseCountry: input.baseCountry, relocation: input.relocation,
          scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
          displayLocation: input.displayLocation, targetRole: input.targetRole,
          salaryMin: input.salaryMin, salaryMax: input.salaryMax,
          salaryCurrency: input.salaryCurrency, salaryCadence: input.salaryCadence,
          attrProvenance: prov,
        })
        .onConflictDoUpdate({
          target: profile.userId,
          set: {
            baseCountry: input.baseCountry, relocation: input.relocation,
            scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
            displayLocation: input.displayLocation, targetRole: input.targetRole,
            salaryMin: input.salaryMin, salaryMax: input.salaryMax,
            salaryCurrency: input.salaryCurrency, salaryCadence: input.salaryCadence,
            attrProvenance: prov,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },
    // Résumé ingestion (Task 4) fills empty attribute fields, but only when
    // the field isn't already "user"-owned — the sticky rule (spec §6). No
    // row yet (onboarding not done) → false, never throw.
    async seedFromResume(
      userId: string,
      seed: { displayLocation: string | null; targetRole: string | null },
    ): Promise<boolean> {
      const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
      if (!row) return false;
      const prov: AttrProvenance = { ...row.attrProvenance };
      const set: { displayLocation?: string; targetRole?: string } = {};
      if (seed.displayLocation !== null && prov.displayLocation !== "user") {
        set.displayLocation = seed.displayLocation;
        prov.displayLocation = "resume";
      }
      if (seed.targetRole !== null && prov.targetRole !== "user") {
        set.targetRole = seed.targetRole;
        prov.targetRole = "resume";
      }
      if (Object.keys(set).length === 0) return false;
      await db.update(profile).set({ ...set, attrProvenance: prov, updatedAt: new Date() }).where(eq(profile.userId, userId));
      return true;
    },
  };
}

export const profileRepo: ReturnType<typeof createProfileRepo> = {
  get: (userId) => createProfileRepo(getDb()).get(userId),
  update: (userId, input) => createProfileRepo(getDb()).update(userId, input),
  upsert: (userId, input) => createProfileRepo(getDb()).upsert(userId, input),
  seedFromResume: (userId, seed) => createProfileRepo(getDb()).seedFromResume(userId, seed),
};
