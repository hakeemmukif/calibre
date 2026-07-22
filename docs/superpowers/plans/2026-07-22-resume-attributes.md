# Resume Attributes & Non-Blocking Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest never discards an analyzed résumé over a missing location/headline; scan-relevant attributes (display location, target role, expected salary) become editable per-user fields on the profile, seeded from extraction with sticky user edits.

**Architecture:** The attribute layer extends the existing `profile` table/entity (spec `docs/superpowers/specs/2026-07-22-resume-attributes-design.md`, Approach A). `deriveLocation`/`deriveHeadline` return `null` instead of throwing; the wire `Resume.headline`/`location` become nullable. Ingest seeds profile attributes after insert under sticky-provenance rules. `deriveRoleTargets` gains the user's `targetRole` as first precedence and fails loud only when no role signal exists anywhere.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod (`src/types` is the contract source of truth), Drizzle + libsql/SQLite, Vitest, Storybook, caliber-ui primitives.

## Global Constraints

- Layering: UI → `features/*` → `server/*`; only `server/*` touches DB/LLM (project CLAUDE.md).
- Fail loud: `Schema.parse` at boundaries; no fallback defaults, no silent `0`/`""`/`unknown`. Nullable fields here mean **explicit absence**, never a default.
- Compose the existing caliber-ui primitives (`Card`, `Input`, `Select`, `Chip`, `Button`, `Icon`, `Tag`); never invent new styling systems. Legitimacy colours stay semantic; red `#e8482b` is brand only.
- `npm run check` (typecheck + vitest + `contract:check` + build) is the canonical gate — run before claiming any task done.
- Dev DB drift caveat: always pass `DATABASE_URL=file:./caliber.db` inline to `db:generate` / `db:migrate` (project CLAUDE.md Commands).
- Small surgical diffs; match existing style and comment density; no `Co-Authored-By` trailers.
- Salary is NEVER extracted from the résumé — user-entered only (spec §2).

---

### Task 1: Attribute fields end-to-end plumbing (types → DB → repo → route → client → pages)

One vertical slice so the build stays green: the six new nullable attribute fields plus `attrProvenance` flow from the contract to the DB and back through GET/PUT `/api/profile`. No provenance *logic* yet (Task 3) — this task passes values through and stamps nothing.

**Files:**
- Modify: `src/types/index.ts` (Profile block, currently lines 99–106)
- Modify: `src/server/persistence/schema.ts:122-135` (profile table)
- Create: `drizzle/0004_*.sql` (generated, not hand-written)
- Modify: `src/server/persistence/repos/profile.ts`
- Modify: `src/app/api/profile/route.ts`
- Modify: `src/app/api/profile/route.test.ts`
- Modify: `src/features/profile/client.ts`
- Modify: `src/app/(app)/profile/page.tsx` (`applyDials`)
- Modify: `src/app/(onboarding)/onboarding/page.tsx` (its `updateProfile` call)
- Modify: `src/caliber-ui/compositions/Profile/ProfileTargets.stories.tsx` (`baseProfile` fixture)

**Interfaces:**
- Produces: `AttrProvenance`, `SalaryCadence`, `ProfileBase`, `salaryRules(p, ctx)` exported from `@/types`; `Profile` now carries `displayLocation`, `targetRole`, `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryCadence` (all nullable, required keys) + `attrProvenance`. `ProfileInput` (repo) carries the same six. `ProfileRow` gains the matching columns.
- Consumed by: Tasks 3–7.

- [ ] **Step 1: Extend the contract in `src/types/index.ts`**

Replace the current Profile block (lines 96–106, keep the comment above it) with:

```ts
export const AttrProvenance = z.object({
  displayLocation: z.enum(["resume", "user"]).optional(),
  targetRole: z.enum(["resume", "user"]).optional(),
  salary: z.literal("user").optional(), // never seeded from the résumé (spec §2)
});
export type AttrProvenance = z.infer<typeof AttrProvenance>;

export const SalaryCadence = z.enum(["monthly", "annual"]);
export type SalaryCadence = z.infer<typeof SalaryCadence>;

// Cross-field salary rules, shared by the wire Profile and the PUT body
// (which omits updatedAt/attrProvenance and so can't reuse the refined
// schema directly).
export function salaryRules(
  p: {
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    salaryCadence: SalaryCadence | null;
  },
  ctx: z.RefinementCtx,
): void {
  const hasAmount = p.salaryMin !== null || p.salaryMax !== null;
  if (hasAmount && p.salaryCurrency === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salaryCurrency"], message: "salaryCurrency is required when a salary amount is set" });
  if (hasAmount && p.salaryCadence === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salaryCadence"], message: "salaryCadence is required when a salary amount is set" });
  if (p.salaryMin !== null && p.salaryMax !== null && p.salaryMin > p.salaryMax)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salaryMin"], message: "salaryMin must be less than or equal to salaryMax" });
}

export const ProfileBase = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex,
  employmentPref: EmploymentPref,
  // Résumé-seeded, user-editable attribute layer (spec 2026-07-22 §3).
  // Nullable = explicitly not set; never defaulted.
  displayLocation: z.string().min(1).nullable(),
  targetRole: z.string().min(1).nullable(),
  salaryMin: z.number().int().positive().nullable(),
  salaryMax: z.number().int().positive().nullable(),
  salaryCurrency: z.string().length(3).nullable(), // ISO-4217
  salaryCadence: SalaryCadence.nullable(),
  attrProvenance: AttrProvenance, // server-computed; read-only on the wire
  updatedAt: z.string().datetime(),
});
export const Profile = ProfileBase.superRefine(salaryRules);
export type Profile = z.infer<typeof Profile>;
```

- [ ] **Step 2: Extend the `profile` table in `src/server/persistence/schema.ts`**

Add an import of the provenance type (top of file, alongside existing type imports): `import type { AttrProvenance } from "@/types";` — check whether schema.ts already imports from `@/types` and merge if so. Then add to the `profile` table columns, after `employmentPref`:

```ts
    displayLocation: text("display_location"),
    targetRole: text("target_role"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryCadence: text("salary_cadence", { enum: ["monthly", "annual"] }),
    attrProvenance: text("attr_provenance", { mode: "json" })
      .$type<AttrProvenance>()
      .notNull()
      .default(sql`'{}'`),
```

- [ ] **Step 3: Generate + apply the migration**

Run: `DATABASE_URL=file:./caliber.db npm run db:generate`
Expected: a new `drizzle/0004_<slug>.sql` containing seven `ALTER TABLE \`profile\` ADD \`...\`` statements (with `DEFAULT '{}' NOT NULL` on `attr_provenance`). Inspect it — no other tables touched.
Run: `DATABASE_URL=file:./caliber.db npm run db:migrate`
Expected: applies cleanly.

- [ ] **Step 4: Write the failing route test updates**

In `src/app/api/profile/route.test.ts`: every existing PUT-body fixture gains the six new fields; GET/PUT response expectations gain the fields + `attrProvenance: {}`. Add these two cases (adapt the file's existing session-mock/db-setup helpers — mirror how its current PUT tests build requests):

```ts
it("PUT 422s when a salary amount is set without a currency", async () => {
  const res = await PUT(
    jsonRequest({
      baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any",
      displayLocation: null, targetRole: null,
      salaryMin: 8000, salaryMax: 12000, salaryCurrency: null, salaryCadence: "monthly",
    }),
  );
  expect(res.status).toBe(422);
});

it("PUT round-trips the attribute fields", async () => {
  const res = await PUT(
    jsonRequest({
      baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any",
      displayLocation: "Kuala Lumpur, Malaysia", targetRole: "Backend Engineer",
      salaryMin: 8000, salaryMax: 12000, salaryCurrency: "MYR", salaryCadence: "monthly",
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.targetRole).toBe("Backend Engineer");
  expect(body.salaryCurrency).toBe("MYR");
});
```

(`jsonRequest` = whatever helper the file already uses to build a `NextRequest` with a JSON body; reuse it verbatim, do not invent a new one.)

- [ ] **Step 5: Run the route tests to verify they fail**

Run: `npx vitest run src/app/api/profile/route.test.ts`
Expected: FAIL — RequestBody rejects unknown/missing fields and `toWire` doesn't emit them yet.

- [ ] **Step 6: Repo — extend `ProfileInput` and pass fields through**

In `src/server/persistence/repos/profile.ts` extend `ProfileInput`:

```ts
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
```

In `update` and `upsert` (both the `.values` and the `.set`/`onConflictDoUpdate.set` objects), add the six fields verbatim from `input` (e.g. `displayLocation: input.displayLocation,` …). Do not touch `attrProvenance` in this task — the column default `{}` covers inserts, existing value survives updates.

- [ ] **Step 7: Route — RequestBody + toWire**

In `src/app/api/profile/route.ts`:

```ts
import { Profile, ProfileBase, salaryRules } from "@/types";

const RequestBody = ProfileBase.omit({ updatedAt: true, attrProvenance: true }).superRefine(salaryRules);
```

`toWire` gains the new fields:

```ts
function toWire(row: ProfileRow): Profile {
  return Profile.parse({
    baseCountry: row.baseCountry,
    relocation: row.relocation,
    scheduleFlex: row.scheduleFlex,
    employmentPref: row.employmentPref,
    displayLocation: row.displayLocation,
    targetRole: row.targetRole,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryCadence: row.salaryCadence,
    attrProvenance: row.attrProvenance,
    updatedAt: row.updatedAt.toISOString(),
  });
}
```

- [ ] **Step 8: Client + the two existing PUT call sites**

`src/features/profile/client.ts` — `updateProfile`'s input type gains the six fields (same shapes as `ProfileInput`; import `SalaryCadence` type from `@/types` if used).

`src/app/(app)/profile/page.tsx` `applyDials` — the PUT must now carry the full body:

```ts
setProfile(
  await updateProfile({
    baseCountry: profile.baseCountry,
    displayLocation: profile.displayLocation,
    targetRole: profile.targetRole,
    salaryMin: profile.salaryMin,
    salaryMax: profile.salaryMax,
    salaryCurrency: profile.salaryCurrency,
    salaryCadence: profile.salaryCadence,
    ...next,
  }),
);
```

`src/app/(onboarding)/onboarding/page.tsx` — find its `updateProfile({ baseCountry, relocation, scheduleFlex, employmentPref })` call and add the six fields as explicit `null`s (first-time create: nothing is set yet).

`ProfileTargets.stories.tsx` `baseProfile` fixture — add `displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null, attrProvenance: {},`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/app/api/profile/route.test.ts`
Expected: PASS.
Run: `npm run contract:check`
Expected: PASS. If it flags generated-artifact drift, run the regenerate counterpart (see the `contract:*` entries in package.json `scripts`), inspect, and include the regenerated files in the commit.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(profile): attribute layer plumbing — displayLocation/targetRole/salary fields end-to-end"
```

---

### Task 2: Non-blocking derivation — `derive-view` returns null, ingest/reextract drop the gate, UI tolerates null

**Files:**
- Modify: `src/server/resume/derive-view.ts`
- Modify: `src/server/resume/derive-view.test.ts`
- Modify: `src/types/index.ts` (Resume, lines 142–143)
- Modify: `src/server/resume/ingest.ts` (drop line 176 gate + import)
- Modify: `src/server/resume/reextract.ts` (drop line 69 gate + import)
- Modify: `src/caliber-ui/compositions/Resume/ResumeView.tsx:31-34`
- Modify: `src/caliber-ui/compositions/Tailor/TailorPreview.tsx:44,57`
- Modify: `src/caliber-ui/compositions/Apply/ResumeRail.tsx:79`

**Interfaces:**
- Produces: `deriveLocation(store): string | null` and `deriveHeadline(store): string | null` **exported** from `derive-view.ts` (Task 4 consumes them for seeding). `assertResumeViewDerivable` is deleted. Wire `Resume.headline`/`Resume.location` are `z.string().nullable()`.
- No change needed elsewhere: `searchRuns.ts:109` already `COALESCE(label, json_extract($.headline), 'Résumé')`; `correlate-metrics.ts` / `eval-metrics.ts` already `?? ""` on store fields; ingest's `label:` already `?? null`-chains.

- [ ] **Step 1: Rewrite the failing tests**

In `derive-view.test.ts`: remove `assertResumeViewDerivable` from the import. Convert the four throw-tests to null-expectations and drop the assert call from the fresh-grad test:

```ts
it("returns a null location when nothing derives one, still yielding a full view", () => {
  const store = baseStore({
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [
      { company: "Acme Co", title: "Senior Backend Engineer", dates: "2022–Present", isCurrent: true, bullets: ["Led migration to Kubernetes"] },
    ],
  });
  const resume = toResumeView(store, opts);
  expect(resume.location).toBeNull();
  expect(resume.headline).toBe("Senior Backend Engineer");
});

it("treats an empty top-level location as absent and returns null when nothing else derives one", () => {
  const store = baseStore({
    location: "",
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [
      { company: "Acme Co", title: "Senior Backend Engineer", dates: "2022–Present", isCurrent: true, bullets: ["Led migration to Kubernetes"] },
    ],
  });
  expect(toResumeView(store, opts).location).toBeNull();
});

it("returns a null headline when no source exists at all, including education", () => {
  const store = baseStore({
    contact: [{ label: "email", value: "jane@example.com" }],
    experience: [],
    education: [],
  });
  const resume = toResumeView(store, opts);
  expect(resume.headline).toBeNull();
  expect(resume.location).toBeNull();
});
```

(The old tests "throws ParseFailedError when location cannot be derived", "…when headline cannot be derived", "treats an empty top-level location … still throws", and "location still fails loud when genuinely absent…" are replaced by the above; the fresh-grad test keeps its `toResumeView` assertions and loses the `expect(() => assertResumeViewDerivable(store)).not.toThrow()` line.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/resume/derive-view.test.ts`
Expected: FAIL (still throws).

- [ ] **Step 3: Implement**

`derive-view.ts`: change both derivers to return `string | null` and export them; delete `assertResumeViewDerivable`; update the module header comment:

```ts
// ResumeStore (rich storage, LLM output) → frozen Resume (wire view).
// Spec 2026-07-22-resume-attributes-design.md §5: headline/location are
// derived best-effort and NULLABLE on the wire — null is explicit absence
// (the profile attribute layer prompts the user), never a default.
// ParseFailedError remains for genuinely unparseable documents (ingest.ts).
```

```ts
export function deriveLocation(store: ResumeStore): string | null {
  if (store.location) return store.location;
  const fromContact = store.contact.find((c) => LOCATION_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  return store.experience[0]?.location ?? null;
}

export function deriveHeadline(store: ResumeStore): string | null {
  if (store.headline) return store.headline;
  const fromContact = store.contact.find((c) => HEADLINE_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  const fromExperience = store.experience[0]?.title;
  if (fromExperience) return fromExperience;
  const fromEducation = store.education[0];
  if (fromEducation) return fromEducation.credential ?? fromEducation.school;
  return null;
}
```

`src/types/index.ts` Resume: `headline: z.string().nullable(),` and `location: z.string().nullable(),`.

`ingest.ts`: delete the `assertResumeViewDerivable(structured);` call and its preceding three-line comment; trim the import to `import { ParseFailedError, toResumeView } from "./derive-view";`; update the module header's "Never persists a partial résumé…" sentence to: `// A résumé with no derivable headline/location is still persisted — the profile attribute layer prompts the user (spec 2026-07-22 §5).`

`reextract.ts`: delete the `assertResumeViewDerivable(structured);` call and the whole `import { assertResumeViewDerivable } from "./derive-view";` line; fix the header comment's pipeline description (drop `assertResumeViewDerivable ->`).

- [ ] **Step 4: UI null tolerance**

`ResumeView.tsx` lines 31–34 become:

```tsx
<div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>
  {resume.headline ?? (
    <a href="/profile" style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>
      Add a headline in Profile &amp; targets
    </a>
  )}
</div>
<div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 3 }}>
  {resume.location ? (
    <>{resume.location} · </>
  ) : (
    <>
      <a href="/profile" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>Add location</a>
      {" · "}
    </>
  )}
  Updated {agoLabel(resume.updatedAt)}
</div>
```

`TailorPreview.tsx`: line 44 → `resume.headline ?? ""` as the base argument to `sectionValue`; line 57 → render the location row only when set: `{resume.location && (<div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{resume.location}</div>)}`.

`ResumeRail.tsx` line 79 → `{resume.headline ?? "—"}`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/server/resume/derive-view.test.ts`
Expected: PASS.
Run: `npm run check`
Expected: GREEN — fix any remaining `Resume.headline`/`.location` string-only assumptions the compiler surfaces (fix them null-safely in place; do not add defaults).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(resume): non-blocking derivation — nullable headline/location, ingest keeps the analyzed resume"
```

---

### Task 3: Sticky provenance — diff-marking on PUT + `seedFromResume` repo method

**Files:**
- Modify: `src/server/persistence/repos/profile.ts`
- Create: `src/server/persistence/repos/profile.test.ts`

**Interfaces:**
- Produces: `profileRepo.seedFromResume(userId, { displayLocation, targetRole }): Promise<boolean>` (false = no row / nothing seeded). `upsert`/`update` now stamp `attrProvenance` by diffing against the existing row: attribute value changed by a PUT → that field's provenance becomes `'user'` (salary's four fields are one unit). Rule (spec §6): seeding writes a field only when the seed value is non-null AND provenance ≠ `'user'`, then marks it `'resume'`.
- Consumes: `AttrProvenance` from `@/types`.

- [ ] **Step 1: Write the failing repo tests**

Create `profile.test.ts` next to the repo. Import the test-DB helper from the same module `src/app/api/profile/route.test.ts` uses (check its imports — reuse identically, including any user-row setup it does). Test through `createProfileRepo(db)`:

```ts
const FULL_INPUT = {
  baseCountry: "MY", relocation: "stay" as const, scheduleFlex: "base-hours" as const, employmentPref: "any" as const,
  displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
};

describe("profileRepo provenance + seeding", () => {
  it("seedFromResume fills empty fields and marks them resume-owned", async () => {
    await repo.upsert(userId, FULL_INPUT);
    const seeded = await repo.seedFromResume(userId, { displayLocation: "Kuala Lumpur", targetRole: "Backend Engineer" });
    expect(seeded).toBe(true);
    const row = await repo.get(userId);
    expect(row.displayLocation).toBe("Kuala Lumpur");
    expect(row.targetRole).toBe("Backend Engineer");
    expect(row.attrProvenance).toEqual({ displayLocation: "resume", targetRole: "resume" });
  });

  it("re-seeding overwrites resume-owned fields but never user-owned ones", async () => {
    await repo.upsert(userId, FULL_INPUT);
    await repo.seedFromResume(userId, { displayLocation: "Kuala Lumpur", targetRole: "Backend Engineer" });
    await repo.upsert(userId, { ...FULL_INPUT, displayLocation: "Kuala Lumpur", targetRole: "Platform Engineer" }); // user edits targetRole
    await repo.seedFromResume(userId, { displayLocation: "Singapore", targetRole: "Data Engineer" });
    const row = await repo.get(userId);
    expect(row.displayLocation).toBe("Singapore"); // resume-owned → refreshed
    expect(row.targetRole).toBe("Platform Engineer"); // user-owned → sticky
    expect(row.attrProvenance).toEqual({ displayLocation: "resume", targetRole: "user" });
  });

  it("a PUT that changes a salary field marks the salary unit user-owned", async () => {
    await repo.upsert(userId, FULL_INPUT);
    await repo.upsert(userId, { ...FULL_INPUT, salaryMin: 8000, salaryMax: 12000, salaryCurrency: "MYR", salaryCadence: "monthly" });
    const row = await repo.get(userId);
    expect(row.attrProvenance.salary).toBe("user");
  });

  it("seedFromResume with null seeds and no row returns false and writes nothing", async () => {
    expect(await repo.seedFromResume("no-such-user", { displayLocation: "KL", targetRole: "X" })).toBe(false);
    await repo.upsert(userId, FULL_INPUT);
    expect(await repo.seedFromResume(userId, { displayLocation: null, targetRole: null })).toBe(false);
  });

  it("an unchanged PUT does not flip resume-owned provenance to user", async () => {
    await repo.upsert(userId, FULL_INPUT);
    await repo.seedFromResume(userId, { displayLocation: "Kuala Lumpur", targetRole: null });
    const before = await repo.get(userId);
    await repo.upsert(userId, { ...FULL_INPUT, displayLocation: "Kuala Lumpur" }); // same value round-tripped
    const after = await repo.get(userId);
    expect(after.attrProvenance).toEqual(before.attrProvenance);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts`
Expected: FAIL — `seedFromResume` doesn't exist; provenance never stamped.

- [ ] **Step 3: Implement in `profile.ts`**

Add a module-private diff helper + the new method; wire provenance into `update` and `upsert` (both now read the existing row first — a second query on a single-row-per-user table is fine and keeps the sticky rule exact):

```ts
import type { AttrProvenance } from "@/types";

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
```

In `update`: fetch `const [existing] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);` first, `if (!existing) throw new ProfileMissingError();`, include `attrProvenance: stampProvenance(existing, input)` in the `.set`. In `upsert`: same pre-read (existing may be undefined), pass `stampProvenance(existing, input)` in both `.values` and the `onConflictDoUpdate.set`.

New method on the repo object (and the `profileRepo` delegate at the bottom of the file):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts src/app/api/profile/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/repos/profile.ts src/server/persistence/repos/profile.test.ts
git commit -m "feat(profile): sticky provenance — user edits win, resume re-seeds only its own fields"
```

---

### Task 4: Ingest seeds the attribute layer

**Files:**
- Modify: `src/server/resume/ingest.ts`

**Interfaces:**
- Consumes: `deriveLocation`/`deriveHeadline` (Task 2), `profileRepo.seedFromResume` + `ProfileMissingError` (Task 3).
- Behaviour: after `insertReplacingActive`, seed `{ displayLocation: deriveLocation(structured), targetRole: deriveHeadline(structured) }`. A missing profile row (registered user who skipped onboarding) is tolerated with a log line — never fails the ingest. Note `seedFromResume` itself never throws `ProfileMissingError` (returns false), so no catch is needed; the boolean is logged.

- [ ] **Step 1: Implement**

In `ingest.ts`, extend the derive-view import: `import { ParseFailedError, toResumeView, deriveHeadline, deriveLocation } from "./derive-view";` and add `import { profileRepo } from "@/server/persistence/repos/profile";`. After the `insertReplacingActive` call and before `return rowToResumeView(inserted);` insert:

```ts
  // Seed the profile attribute layer (spec 2026-07-22 §6): sticky rules live
  // in the repo — user-owned fields are never touched. false = no profile
  // row yet (onboarding not done) or nothing new to seed; either way the
  // ingest result is unaffected.
  const seeded = await profileRepo.seedFromResume(userId, {
    displayLocation: deriveLocation(structured),
    targetRole: deriveHeadline(structured),
  });
  console.log("resume ingest: attribute seeding", { seeded });
```

- [ ] **Step 2: Verify**

Run: `npx vitest run src/server/resume`
Expected: PASS (existing ingest tests, if any, still green — if an ingest test constructs a test DB without a profile row, the `false` path exercises silently).
Run: `npm run check`
Expected: GREEN.

- [ ] **Step 3: Commit**

```bash
git add src/server/resume/ingest.ts
git commit -m "feat(resume): ingest seeds profile displayLocation/targetRole under sticky rules"
```

---

### Task 5: Scan gate — `targetRole` first in role precedence, loud actionable failure

**Files:**
- Modify: `src/server/search/roleMatch.ts` (`deriveRoleTargets`, lines 255–273)
- Modify: `src/server/search/run.ts:290` (call site; `profile` is already in `runFanOut`'s scope)
- Test: extend the existing test file covering `deriveRoleTargets` (locate `roleMatch`'s test file next to it; if none covers `deriveRoleTargets`, add `src/server/search/roleMatch.test.ts` cases using the store fixture shape from `derive-view.test.ts`'s `baseStore`)

**Interfaces:**
- Produces: `deriveRoleTargets(resume, persona, targetRole: string | null): RoleTarget[]` and `export class NoRoleSignalError extends Error`. Precedence: `targetRole` (user) → `store.headline` → `experience[0].title`; experience titles always included. Throws `NoRoleSignalError` when the final `titles` list is empty (fresh-grad, nothing anywhere).
- Consumed by: `run.ts` — the error message lands in `search_runs.error` via the existing `failRun` net and is what the user sees.

- [ ] **Step 1: Write the failing tests**

```ts
it("puts the user's targetRole first in precedence, ahead of store.headline", () => {
  const targets = deriveRoleTargets({ structured: baseStore({ headline: "Senior Backend Engineer" }) }, "remote", "Engineering Manager");
  expect(targets[0].titles).toContain("Engineering Manager");
});

it("falls back to the store chain when targetRole is null", () => {
  const targets = deriveRoleTargets({ structured: baseStore() }, "remote", null);
  expect(targets[0].titles.length).toBeGreaterThan(0);
});

it("throws NoRoleSignalError when there is no targetRole, headline, or experience", () => {
  const store = baseStore({ headline: undefined, contact: [{ label: "email", value: "jane@example.com" }], experience: [] });
  expect(() => deriveRoleTargets({ structured: store }, "remote", null)).toThrow(NoRoleSignalError);
});

it("a targetRole alone rescues an empty résumé", () => {
  const store = baseStore({ headline: undefined, contact: [{ label: "email", value: "jane@example.com" }], experience: [] });
  const targets = deriveRoleTargets({ structured: store }, "remote", "Product Designer");
  expect(targets[0].titles).toContain("Product Designer");
});
```

(Reuse/adapt the local `baseStore` fixture pattern; the education entries in the fixture don't feed `deriveRoleTargets`, so an empty-experience store with no headline has no role signal.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/search/roleMatch.test.ts`
Expected: FAIL (wrong arity / no error class).

- [ ] **Step 3: Implement**

In `roleMatch.ts`:

```ts
export class NoRoleSignalError extends Error {
  constructor() {
    super(
      "No role signal to scan with — the résumé has no headline or experience titles, and no target role is set. Set \"What kind of job are you looking for?\" in Profile & targets, then scan again.",
    );
    this.name = "NoRoleSignalError";
  }
}
```

`deriveRoleTargets` (update its doc comment to mention the user-set target as first precedence, spec 2026-07-22 §7):

```ts
export function deriveRoleTargets(
  resume: Pick<ResumeRow, "structured">,
  persona: "remote" | "local",
  targetRole: string | null,
): RoleTarget[] {
  const store = resume.structured;
  const headline = targetRole ?? store.headline ?? store.experience[0]?.title;

  const titles = dedupePreserveOrder([...(headline ? [headline] : []), ...store.experience.map((e) => e.title)]);
  if (titles.length === 0) throw new NoRoleSignalError();
  const keywords = dedupePreserveOrder(store.skills.flatMap((g) => g.items));

  return [{ titles: expandRoleTitles(titles), keywords, persona }];
}
```

In `run.ts` line 290: `const targets = deriveRoleTargets(resumeRow, persona, profile.targetRole);` — it stays inside the `try`, so `NoRoleSignalError` reaches `failRun` and its message is stored on the run / shown in the scan UI. Update the comment above it to say the throw is now also the no-role-signal gate (spec 2026-07-22 §7), not just corrupted-résumé insurance.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/search`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(search): user targetRole leads role precedence; loud NoRoleSignalError gate"
```

---

### Task 6: `/profile` Job targets card

**Files:**
- Create: `src/caliber-ui/compositions/Profile/JobTargets.tsx`
- Create: `src/caliber-ui/compositions/Profile/JobTargets.stories.tsx`
- Modify: `src/app/(app)/profile/page.tsx`

**Interfaces:**
- Produces: `JobTargets` composition — props `{ profile: Profile; busy: boolean; onSave(fields: JobTargetsFields): void }`, `JobTargetsFields = Pick<Profile, "displayLocation" | "targetRole" | "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryCadence">`. Draft-state + explicit Save (text inputs don't save-on-change like the dial chips); client-side mirror of `salaryRules` gates the Save button; provenance hints from `profile.attrProvenance`.
- Consumes: `updateProfile` (Task 1 shape) via the page's handler.

- [ ] **Step 1: Write the composition**

`JobTargets.tsx` — complete file:

```tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import { Button } from "../../components/Button";
import type { Profile, SalaryCadence } from "../../../types";

export type JobTargetsFields = Pick<
  Profile,
  "displayLocation" | "targetRole" | "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryCadence"
>;

export interface JobTargetsProps {
  profile: Profile;
  busy: boolean;
  onSave(fields: JobTargetsFields): void;
}

const CURRENCY_OPTIONS = [
  { value: "", label: "Currency…" },
  { value: "MYR", label: "MYR" },
  { value: "USD", label: "USD" },
  { value: "SGD", label: "SGD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
];

const CADENCE_OPTIONS: { value: SalaryCadence; label: string }[] = [
  { value: "monthly", label: "Per month" },
  { value: "annual", label: "Per year" },
];

interface Draft {
  displayLocation: string;
  targetRole: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryCadence: SalaryCadence | null;
}

function toDraft(profile: Profile): Draft {
  return {
    displayLocation: profile.displayLocation ?? "",
    targetRole: profile.targetRole ?? "",
    salaryMin: profile.salaryMin?.toString() ?? "",
    salaryMax: profile.salaryMax?.toString() ?? "",
    salaryCurrency: profile.salaryCurrency ?? "",
    salaryCadence: profile.salaryCadence,
  };
}

// undefined = invalid input (blocks Save); null = intentionally empty.
function parseAmount(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function ProvenanceHint({ owner }: { owner: "resume" | "user" | undefined }) {
  if (!owner) return null;
  return (
    <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginLeft: 8 }}>
      {owner === "resume" ? "from résumé" : "edited"}
    </span>
  );
}

// Job targets card (spec 2026-07-22-resume-attributes-design.md §8): the
// résumé-seeded, user-editable attribute layer. Free-text fields use a
// draft + explicit Save (unlike the dial chips' save-on-change) so a
// half-typed salary never fires a PUT; the Save gate mirrors the server's
// salaryRules so a 422 is unreachable from here.
export function JobTargets({ profile, busy, onSave }: JobTargetsProps) {
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(profile));
  React.useEffect(() => setDraft(toDraft(profile)), [profile]);

  const min = parseAmount(draft.salaryMin);
  const max = parseAmount(draft.salaryMax);
  const hasAmount = (min ?? null) !== null || (max ?? null) !== null;
  const validationMessage =
    min === undefined || max === undefined
      ? "Salary amounts must be positive whole numbers."
      : typeof min === "number" && typeof max === "number" && min > max
        ? "Minimum salary must not exceed the maximum."
        : hasAmount && (!draft.salaryCurrency || !draft.salaryCadence)
          ? "Pick a currency and a cadence for the salary range."
          : null;

  const fields: JobTargetsFields | null = validationMessage
    ? null
    : {
        displayLocation: draft.displayLocation.trim() || null,
        targetRole: draft.targetRole.trim() || null,
        salaryMin: min ?? null,
        salaryMax: max ?? null,
        salaryCurrency: draft.salaryCurrency || null,
        salaryCadence: draft.salaryCadence,
      };

  const dirty =
    fields !== null &&
    (fields.displayLocation !== profile.displayLocation ||
      fields.targetRole !== profile.targetRole ||
      fields.salaryMin !== profile.salaryMin ||
      fields.salaryMax !== profile.salaryMax ||
      fields.salaryCurrency !== profile.salaryCurrency ||
      fields.salaryCadence !== profile.salaryCadence);

  return (
    <Card padding="md" radius="lg" elevation="sm" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>Job targets</div>
        <div>
          <Input
            label={
              <>
                Target role
                <ProvenanceHint owner={profile.attrProvenance.targetRole} />
              </>
            }
            placeholder="e.g. Backend Engineer"
            value={draft.targetRole}
            onChange={(e) => setDraft((d) => ({ ...d, targetRole: e.target.value }))}
            disabled={busy}
          />
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 6 }}>
            Scans match against this first, before your résumé's headline.
          </div>
        </div>
        <Input
          label={
            <>
              Location
              <ProvenanceHint owner={profile.attrProvenance.displayLocation} />
            </>
          }
          placeholder="e.g. Kuala Lumpur, Malaysia"
          value={draft.displayLocation}
          onChange={(e) => setDraft((d) => ({ ...d, displayLocation: e.target.value }))}
          disabled={busy}
        />
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
            Expected salary
            <ProvenanceHint owner={profile.attrProvenance.salary} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 8 }}>
            <Input
              placeholder="Min"
              inputMode="numeric"
              value={draft.salaryMin}
              onChange={(e) => setDraft((d) => ({ ...d, salaryMin: e.target.value }))}
              disabled={busy}
            />
            <Input
              placeholder="Max"
              inputMode="numeric"
              value={draft.salaryMax}
              onChange={(e) => setDraft((d) => ({ ...d, salaryMax: e.target.value }))}
              disabled={busy}
            />
            <Select
              value={draft.salaryCurrency}
              onChange={(v) => setDraft((d) => ({ ...d, salaryCurrency: v }))}
              options={CURRENCY_OPTIONS}
              disabled={busy}
            />
          </div>
          <div
            style={{
              display: "inline-flex",
              gap: 4,
              padding: 3,
              marginTop: 8,
              background: "var(--surface-sunken)",
              borderRadius: "var(--radius-pill, 999px)",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {CADENCE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={draft.salaryCadence === opt.value}
                aria-pressed={draft.salaryCadence === opt.value}
                onClick={() => setDraft((d) => ({ ...d, salaryCadence: d.salaryCadence === opt.value ? null : opt.value }))}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button variant="primary" disabled={busy || !dirty} onClick={() => fields && onSave(fields)}>
            Save targets
          </Button>
          {validationMessage && (
            <span style={{ font: "var(--type-caption)", color: "var(--danger-ink)" }}>{validationMessage}</span>
          )}
        </div>
      </div>
    </Card>
  );
}
```

Note: check `Select`'s actual `onChange` signature in `src/caliber-ui/components/Select.tsx` before wiring — `ProfileTargets` passes `onChange={() => {}}`; if it hands back a DOM event rather than the value string, adapt the two `onChange` handlers accordingly.

- [ ] **Step 2: Stories**

`JobTargets.stories.tsx` — mirror the ProfileTargets CSF exactly:

```tsx
import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { JobTargets } from "./JobTargets";
import type { Profile } from "../../../types";

const meta: Meta<typeof JobTargets> = {
  title: "Compositions/Profile/JobTargets",
  component: JobTargets,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobTargets>;

const baseProfile: Profile = {
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "any-hours",
  employmentPref: "any",
  displayLocation: "Kuala Lumpur, Malaysia",
  targetRole: "Backend Engineer",
  salaryMin: 8000,
  salaryMax: 12000,
  salaryCurrency: "MYR",
  salaryCadence: "monthly",
  attrProvenance: { displayLocation: "resume", targetRole: "user", salary: "user" },
  updatedAt: "2026-07-22T00:00:00.000Z",
};

export const Populated: Story = {
  args: { profile: baseProfile, busy: false, onSave: () => {} },
};

export const Empty: Story = {
  args: {
    profile: {
      ...baseProfile,
      displayLocation: null,
      targetRole: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryCadence: null,
      attrProvenance: {},
    },
    busy: false,
    onSave: () => {},
  },
};

export const Busy: Story = {
  args: { profile: baseProfile, busy: true, onSave: () => {} },
};
```

- [ ] **Step 3: Wire into the page**

`src/app/(app)/profile/page.tsx`: import `JobTargets, type JobTargetsFields`; add below `applyDials`:

```ts
async function applyTargets(fields: JobTargetsFields) {
  if (!profile) return;
  setBusy(true);
  setError(undefined);
  try {
    setProfile(
      await updateProfile({
        baseCountry: profile.baseCountry,
        relocation: profile.relocation,
        scheduleFlex: profile.scheduleFlex,
        employmentPref: profile.employmentPref,
        ...fields,
      }),
    );
  } catch (err) {
    setError(err instanceof Error ? err.message : "Couldn't update the profile.");
  } finally {
    setBusy(false);
  }
}
```

Render `<JobTargets profile={profile} busy={busy} onSave={(f) => void applyTargets(f)} />` directly after `<ProfileTargets …/>` inside the existing `{profile && (…)}` guard (wrap both in a fragment).

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: GREEN.
Run: `npm run storybook` (spot-check Compositions/Profile/JobTargets renders in all three stories, provenance hints visible, Save disabled until dirty+valid). Kill it after.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(profile): Job targets card — editable resume-seeded attributes with provenance hints"
```

---

### Task 7: Finish-setup card on the résumé page

**Files:**
- Create: `src/caliber-ui/compositions/Resume/FinishSetupCard.tsx`
- Create: `src/caliber-ui/compositions/Resume/FinishSetupCard.stories.tsx`
- Modify: `src/app/(app)/resume/page.tsx`

**Interfaces:**
- Produces: `FinishSetupCard` — props `{ needsTargetRole: boolean; needsLocation: boolean; busy: boolean; error?: string; onSubmit(values: { targetRole: string | null; displayLocation: string | null }): void }`.
- Behaviour (spec §8): the card appears only while `profile.targetRole === null` (the scan-critical gap); a missing `displayLocation` rides along as an optional input, never triggers the card alone. Profile 404 (registered, skipped onboarding) → a link card to `/profile` instead.

- [ ] **Step 1: Write the composition**

`FinishSetupCard.tsx` — complete file:

```tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export interface FinishSetupValues {
  targetRole: string | null;
  displayLocation: string | null;
}

export interface FinishSetupCardProps {
  needsTargetRole: boolean;
  needsLocation: boolean;
  busy: boolean;
  error?: string;
  onSubmit(values: FinishSetupValues): void;
}

// Post-upload gap-filler (spec 2026-07-22-resume-attributes-design.md §8):
// renders ONLY the missing scan attributes. Target role is the scan gate;
// location is an optional rider. Values land on the profile via the page.
export function FinishSetupCard({ needsTargetRole, needsLocation, busy, error, onSubmit }: FinishSetupCardProps) {
  const [targetRole, setTargetRole] = React.useState("");
  const [location, setLocation] = React.useState("");
  const canSave = !needsTargetRole || targetRole.trim().length > 0;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Finish setting up your scan</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            Your résumé is saved — it just didn't state everything scanning needs. Fill the gaps below (editable later in
            Profile &amp; targets).
          </div>
        </div>
        {needsTargetRole && (
          <Input
            label="What kind of job are you looking for?"
            placeholder="e.g. Backend Engineer"
            value={targetRole}
            onChange={(e) => setTargetRole(e.target.value)}
            disabled={busy}
          />
        )}
        {needsLocation && (
          <Input
            label="Where are you based? (optional)"
            placeholder="e.g. Kuala Lumpur, Malaysia"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            disabled={busy}
          />
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger-ink)" }}>
            <Icon name="triangle-alert" size={16} />
            <span style={{ font: "var(--type-caption)" }}>{error}</span>
          </div>
        )}
        <div>
          <Button
            variant="primary"
            disabled={busy || !canSave}
            onClick={() => onSubmit({ targetRole: targetRole.trim() || null, displayLocation: location.trim() || null })}
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Stories**

`FinishSetupCard.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { FinishSetupCard } from "./FinishSetupCard";

const meta: Meta<typeof FinishSetupCard> = {
  title: "Compositions/Resume/FinishSetupCard",
  component: FinishSetupCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof FinishSetupCard>;

export const RoleAndLocationMissing: Story = {
  args: { needsTargetRole: true, needsLocation: true, busy: false, onSubmit: () => {} },
};

export const RoleOnlyMissing: Story = {
  args: { needsTargetRole: true, needsLocation: false, busy: false, onSubmit: () => {} },
};

export const WithError: Story = {
  args: {
    needsTargetRole: true,
    needsLocation: true,
    busy: false,
    error: "Couldn't update the profile.",
    onSubmit: () => {},
  },
};
```

- [ ] **Step 3: Wire into the résumé page**

`src/app/(app)/resume/page.tsx` — add imports:

```ts
import { FinishSetupCard, type FinishSetupValues } from "@/caliber-ui/compositions/Resume/FinishSetupCard";
import { getProfile, updateProfile } from "@/features/profile/client";
import type { Profile } from "@/types";
```

Add state:

```ts
const [profile, setProfile] = React.useState<Profile | null>(null);
const [profileMissing, setProfileMissing] = React.useState(false);
const [setupBusy, setSetupBusy] = React.useState(false);
const [setupError, setSetupError] = React.useState<string | undefined>();
```

Extend the load effect (the existing `React.useEffect` at line 48):

```ts
React.useEffect(() => {
  void getResume().then((r) => {
    setResume(r);
    setLoaded(true);
  });
  void getProfile()
    .then(setProfile)
    .catch((err) => {
      if (err instanceof ApiError && err.status === 404) setProfileMissing(true);
      else setSetupError(err instanceof Error ? err.message : "Couldn't load the profile.");
    });
}, []);
```

Also refresh the profile after an upload succeeds — in `handleFile` after `setJustUploaded(true);` add: `void getProfile().then(setProfile).catch(() => {});` — hmm, a silent catch contradicts fail-loud; instead reuse the same catch as the effect (extract a `loadProfile` callback used by both, mirroring the effect's catch exactly). Implement it as:

```ts
const loadProfile = React.useCallback(async () => {
  try {
    setProfile(await getProfile());
    setProfileMissing(false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) setProfileMissing(true);
    else setSetupError(err instanceof Error ? err.message : "Couldn't load the profile.");
  }
}, []);
```

and call `void loadProfile();` from the effect and from `handleFile` after `setJustUploaded(true)` (ingest may have seeded `targetRole`, which decides whether the card shows).

Add the submit handler:

```ts
async function handleFinishSetup(values: FinishSetupValues) {
  if (!profile) return;
  setSetupBusy(true);
  setSetupError(undefined);
  try {
    setProfile(
      await updateProfile({
        baseCountry: profile.baseCountry,
        relocation: profile.relocation,
        scheduleFlex: profile.scheduleFlex,
        employmentPref: profile.employmentPref,
        displayLocation: values.displayLocation ?? profile.displayLocation,
        targetRole: values.targetRole ?? profile.targetRole,
        salaryMin: profile.salaryMin,
        salaryMax: profile.salaryMax,
        salaryCurrency: profile.salaryCurrency,
        salaryCadence: profile.salaryCadence,
      }),
    );
  } catch (err) {
    setSetupError(err instanceof Error ? err.message : "Couldn't save.");
  } finally {
    setSetupBusy(false);
  }
}
```

In the JSX, directly above `<ResumeView …/>` (inside the `resume ? (…)` branch, after the `justUploaded` card):

```tsx
{profile && profile.targetRole === null && (
  <FinishSetupCard
    needsTargetRole
    needsLocation={profile.displayLocation === null}
    busy={setupBusy}
    error={setupError}
    onSubmit={(v) => void handleFinishSetup(v)}
  />
)}
{profileMissing && (
  <Card style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
        Complete your profile to enable scanning.
      </div>
      <Button variant="secondary" onClick={() => router.push("/profile")}>
        Open Profile &amp; targets
      </Button>
    </div>
  </Card>
)}
```

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: GREEN.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(resume): finish-setup card fills missing scan attributes post-upload"
```

---

### Task 8: Full gate + runtime verification

**Files:** none new.

- [ ] **Step 1: Full gate**

Run: `npm run check`
Expected: GREEN (typecheck + all vitest + contract:check + build).

- [ ] **Step 2: Runtime drive (use the `/verify` skill's boot recipe)**

Drive the loop end-to-end with the dev server + LLM test-doubles per `/verify`:
1. Paste a résumé **without any location or headline** → expect 200, résumé visible, FinishSetupCard shown asking for the job kind (+ optional location).
2. Fill the card → card disappears; `/profile` Job targets shows the values marked "edited"/set.
3. Start a scan with target role set on an experience-less résumé → scan proceeds past role targeting; with target role cleared AND no résumé signal → run fails with the "No role signal…" message in the scan UI.
4. Re-upload a résumé that DOES state a location → profile `displayLocation` updates only if it was resume-owned; a user-edited value survives.

- [ ] **Step 3: Commit any verification fixes, then hand back**

```bash
git status
```
Expected: clean (or commit fixes with focused messages). Report results to the operator — deploy to the box is the operator's call.
