# Remote-Fit Criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-side preference dials (`scheduleFlex`, `employmentPref`) and job-side stated restriction facts (`tz_band`, `hiring_structure`, `workCalendar`) so a remote-global job is hidden from the feed only when it *provably* conflicts with the operator's schedule/employment tolerance — composed at feed-read, match-score untouched.

**Architecture:** Mirror the proven eligibility subsystem exactly — **facts on the job (columns), dials on the profile (singleton), composed by a server-side predicate at feed-read**. A pure resolver (`resolveTzBand`, beside `resolveEligibility`) normalizes stated TZ tokens to coarse bands; the LLM extracts stated facts only; gates hide nothing on a guess. The feature ships **dark by construction** — the seed is permissive so the feed is byte-identical until a dial is touched, and the extraction liveness fix must be live-verified (3/3) before the gates are trusted.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript · Zod (contract in `src/types`) · Drizzle + **Postgres** (PGlite in-memory for tests — *no SQLite anywhere*) · Vitest + @testing-library/react · Playwright (E2E) · OpenRouter LLM (`config/models.yml`, gpt-oss-120b for jd-extract).

**Spec (single source of truth — do not re-derive):** `docs/superpowers/specs/2026-07-14-remote-fit-criteria-design.md`. Predecessor it extends: `docs/superpowers/specs/2026-07-12-remote-local-eligibility-design.md`.

## Global Constraints

- **`src/types/index.ts` is the single source of truth.** Any change there must be mirrored in `docs/architecture/api-contract.md` and re-generated via `npm run contract:check` (regenerates `src/contract/openapi.json` and `git diff --exit-code`s it — the build fails until you commit the regenerated file).
- **Fail loud.** No fallback defaults, no silent `0`/`""`/`unknown`. Missing required value → throw. `ProfileMissingError` semantics are preserved (missing singleton row still throws; never defaulted at runtime).
- **Permissive seed = byte-identical feed.** `scheduleFlex: "any-hours"`, `employmentPref: "any"` admit everything; a migration/seed no-op proof is a required test.
- **Stated facts only.** The jd-extract "do not guess" contract is extended verbatim. The single sanctioned inference: an explicitly contract-term role ("12-month contract") ⇒ `hiringStructure: "contractor"`.
- **No gate hides on a guess.** Schedule gate needs a mapped band; structure gate needs a stated enum. `NULL` column always passes. Ambiguous/unmapped TZ token → `null` + `console.warn` log, never a band.
- **`match-score.md` template is untouched** (fit stays orthogonal to geography/schedule/structure). `Persona`, eligibility tier semantics, dedupe keys, `PersonaToggle`, tracker entities are untouched.
- **Enum values are frozen strings** (copy verbatim): `ScheduleFlex = ["base-hours","flex-evenings","any-hours"]` (ordered) · `EmploymentPref = ["any","employee","local-entity"]` · `TzBand = ["apac","emea","americas"]` · `HiringStructure = ["local-entity","eor","contractor"]`.
- **Test commands:** single file `npx vitest run <path>`; full gate `npm run check` (= `typecheck && vitest run && contract:check && build`); E2E `npm run test:e2e`.
- **Style:** small surgical diffs, match existing style, no speculative abstractions. Commit after every green step.

## RESOLVED DECISIONS (Fable review, 2026-07-14 — grounded in code reads)

**D1 — `policyVersion` → do NOT bump; the spec §4 line is a documented erratum.** The review established that `policyVersion` has **no read path that triggers re-scoring**: the scan path scores top-N unconditionally (no cache check, `src/server/search/run.ts:419-434`) and the feed picks the latest score by `createdAt` regardless of policy. Its only uses are the upsert conflict target and the row stamp. So "bumping" it triggers nothing — it would only make re-evaluations *append* score rows instead of overwriting. The spec's real intent ("re-evaluations refresh cleanly") is **already satisfied**: `scoreJob` always re-runs extraction and the upsert `set` includes `jdFacts`. The decoupling is a twice-recorded prior decision (`2026-07-11-manual-url-scan-design.md:170`; `2026-07-12-pasted-job-ingestion-design.md:22`) with a guard test (`jdFacts.test.ts:110-118`). **Action: Task 3 does not touch `policyVersion` or `templates.ts`; the guard test stays green. Record a one-line erratum against spec §4's "policyVersion bumps" clause.**

**D2 — schedule/structure pills ride `Job.tags` with `tone: "neutral"` + an additive `title?`.** Confirmed sound (`assembleJob` receives the full score row; feed/detail reads inner-join `job_scores`, so an assembled job always has a score row; `Tag` spreads `...rest`, so a native `title` works) — with three corrections folded into Task 7: (1) `job_scores.jdFacts` is `jsonb $type<unknown>` → cast via `JdFactsSchema`/`as JdFacts` (the `recompute-eligibility.ts:31` precedent); (2) wire `Tone` (`src/types/index.ts:16` = `["verified","good","warn","ghost","danger"]`) lacks `"neutral"` → extend it (additive; the UI `TagTone` already styles it); (3) `JobRow` does **not** render `Job.tags` today → it must render the schedule/structure pills. **Clean discriminator:** the new pills carry `tone: "neutral"` (legitimacy tones are always semantic), so `JobRow` renders exactly them via `job.tags.filter(t => t.tone === "neutral")` — no legitimacy duplication, and `JobDetail`'s existing `tags.map` simply gains the two pills (no change needed there).

---

## File Structure (what gets created / modified)

**Created**
- `src/server/score/tzBand.ts` — pure `resolveTzBand` + `probeTzToken` (non-logging) + token table + `allowedBandsFor` + `allowedStructuresFor` (mirrors `eligibility.ts`).
- `src/server/score/tzBand.test.ts` — resolver + mapping unit tests.
- `src/server/score/remote-fit-coverage.ts` — the §11 validation-gate coverage script (band/structure distribution).
- `drizzle/0008_<slug>.sql` (+ `meta/0008_snapshot.json`, `_journal.json` entry) — generated, then hand-edited for the profile columns.
- `e2e/remote-fit.spec.ts` (or the repo's E2E dir) — the one journey.

**Modified**
- `src/types/index.ts` — `ScheduleFlex`/`EmploymentPref` enums, `Profile` +2 fields, (D2) `Job.tags` entry `title?`.
- `docs/architecture/api-contract.md` — Profile block, four-axis paragraph, new enums, feed-predicate prose.
- `src/contract/openapi.json` — regenerated.
- `src/server/persistence/schema.ts` — `profile` +2 cols, `jobs` +2 cols.
- `src/server/persistence/seed.ts` + `seed-test.ts` — permissive dial seeds.
- `src/server/persistence/repos/profile.ts` — widen `update` input + `.set`.
- `src/server/persistence/repos/jobs.ts` — `updateRemoteFit`, predicate conditions, generalized hidden-count.
- `src/server/score/jdFacts.ts` — emission schema (required-nullable all fields), both callers.
- `config/templates/jd-extract.md` — `tzRequirement`/`hiringStructure`/`workCalendar`, stated-only.
- `src/server/search/run.ts` — ingest stamps `tz_band` (Layer-B).
- `src/server/score/index.ts` — score-path authoritative `tz_band`/`hiring_structure` refresh.
- `src/server/score/recompute-eligibility.ts` — extend to re-derive `tz_band`.
- `src/server/search/jobsFeed.ts` — compose schedule + structure gates; generalized `excluded`.
- `src/features/feed/assemble.ts` — push schedule/structure tags; `workCalendar` passthrough.
- `src/caliber-ui/compositions/Feed/SummaryStrip.tsx` — generalized strip label.
- `src/caliber-ui/compositions/Detail/JobDetail.tsx` — `workCalendar` in gaps panel.
- `src/caliber-ui/compositions/Profile/ProfileTargets.tsx` — preset row + 2 controls.
- `src/app/profile/page.tsx` — schedule/employment handlers.
- `src/features/profile/client.ts` — widen `updateProfile` input.
- `docs/architecture/system-architecture.md`, `docs/architecture/component-inventory.md` — doc ripple.

---

## Task 1: Contract & types — enums + Profile dials

**Goal:** `ScheduleFlex`/`EmploymentPref` exist in `src/types`, `Profile` carries both new fields, api-contract.md mirrors them, and `npm run contract:check` passes with the regenerated openapi committed.

**Subagent:** **Sonnet (`executor`)** — mechanical, spec-exact contract edit. Review gate: Fable (inline) — confirm four-axis paragraph wording and that no `Job` top-level field was added (D2 is a *tags-entry* change, deferred to Task 7).

**Files:**
- Modify: `src/types/index.ts:80-91` (enums near `RelocationPref`, `Profile` object)
- Modify: `src/types/index.test.ts`
- Modify: `docs/architecture/api-contract.md` (Profile block ~L85-89, enum block ~L64-73, four-axis paragraph L229)
- Regenerate: `src/contract/openapi.json`

**Interfaces:**
- Produces: `ScheduleFlex` (`z.enum(["base-hours","flex-evenings","any-hours"])`), `EmploymentPref` (`z.enum(["any","employee","local-entity"])`), and the inferred TS types; `Profile` gains `scheduleFlex: ScheduleFlex`, `employmentPref: EmploymentPref`. Consumed by Tasks 2, 6, 8.

- [ ] **Step 1: Write the failing test** — append to `src/types/index.test.ts`:

```ts
import { ScheduleFlex, EmploymentPref, Profile } from "./index";

describe("ScheduleFlex / EmploymentPref", () => {
  it("ScheduleFlex accepts the three ordered levels and rejects others", () => {
    expect(ScheduleFlex.parse("base-hours")).toBe("base-hours");
    expect(ScheduleFlex.parse("flex-evenings")).toBe("flex-evenings");
    expect(ScheduleFlex.parse("any-hours")).toBe("any-hours");
    expect(() => ScheduleFlex.parse("evenings")).toThrow();
  });
  it("EmploymentPref accepts any|employee|local-entity", () => {
    expect(EmploymentPref.parse("employee")).toBe("employee");
    expect(() => EmploymentPref.parse("eor")).toThrow();
  });
  it("Profile requires the two new dials (fail loud, no default)", () => {
    expect(() =>
      Profile.parse({ baseCountry: "MY", relocation: "stay", updatedAt: "2026-07-14T00:00:00.000Z" }),
    ).toThrow();
    const p = Profile.parse({
      baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(p.scheduleFlex).toBe("any-hours");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/types/index.test.ts` → FAIL (`ScheduleFlex` is not exported / Profile accepts the 3-field object).

- [ ] **Step 3: Implement** — in `src/types/index.ts`, immediately after `RelocationPref` (L80-81) add:

```ts
export const ScheduleFlex = z.enum(["base-hours", "flex-evenings", "any-hours"]); // ordered: each level includes the ones before it
export type ScheduleFlex = z.infer<typeof ScheduleFlex>;

export const EmploymentPref = z.enum(["any", "employee", "local-entity"]); // "employee" admits local entity OR EOR
export type EmploymentPref = z.infer<typeof EmploymentPref>;
```

Then extend `Profile` (L86-90):

```ts
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex,
  employmentPref: EmploymentPref,
  updatedAt: z.string().datetime(),
});
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/types/index.test.ts` → PASS.

- [ ] **Step 5: Mirror the contract doc** — in `docs/architecture/api-contract.md`: add the two `z.enum` lines beside the eligibility enum block (~L64-73), add `scheduleFlex`/`employmentPref` to the Profile block (~L85-89), and amend the three-axis guard paragraph (L229) to **four axes** by appending: `· schedule/structure facts = stated constraints (tz_band, hiring_structure) matched against the profile dials (scheduleFlex, employmentPref) at feed-read, never LLM-judged.`

- [ ] **Step 6: Regenerate + verify the contract** — `npm run contract:check`. Expected: it regenerates `src/contract/openapi.json`; if it fails on a diff, the regenerated file is the fix. Then `npx vitest run src/contract/registry.test.ts src/contract/route-coverage.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/types/index.test.ts docs/architecture/api-contract.md src/contract/openapi.json
git commit -m "feat(remote-fit): add ScheduleFlex/EmploymentPref enums + Profile dials (contract)"
```

---

## Task 2: Persistence — schema columns, migration, permissive seed

**Goal:** `profile` has `schedule_flex`/`employment_pref` NOT-NULL columns (existing singleton row backfilled to the permissive dials via the migration), `jobs` has nullable `tz_band`/`hiring_structure`, the seed/repo carry the new fields, and a no-op proof shows the feed is byte-identical under the permissive seed.

**Subagent:** **Sonnet (`executor`)** — schema + generated migration + hand-edit for the NOT-NULL profile columns (the one non-mechanical bit). Review gate: Fable (inline) — verify the migration uses the temp-default-then-drop pattern for the profile columns (a bare `ADD COLUMN NOT NULL` would fail on real Postgres against the existing `default` row, though PGlite tests apply to an empty table and would not catch it).

**Files:**
- Modify: `src/server/persistence/schema.ts` (`profile` L82-91, `jobs` L116-139)
- Create: `drizzle/0008_<slug>.sql` (+ meta snapshot + journal entry) via `db:generate`, then hand-edit
- Modify: `src/server/persistence/seed.ts:57-65`, `src/server/persistence/seed-test.ts`
- Modify: `src/server/persistence/repos/profile.ts:27-35`
- Modify/Test: `src/server/persistence/repos/profile.test.ts`
- **Also update every bare `insert(profile)` site** (NOT-NULL columns break them): the shared fixture `src/server/persistence/repos/__fixtures__/helpers.ts` (jobsFeed + repo tests route through it) and `src/app/api/profile/route.test.ts` — run `grep -rn "insert(profile)" src` to find all sites.

**Interfaces:**
- Consumes: `ScheduleFlex`/`EmploymentPref` enum string sets (Task 1).
- Produces: DB columns `profile.schedule_flex`/`profile.employment_pref` (ts: `scheduleFlex`/`employmentPref`), `jobs.tz_band`/`jobs.hiring_structure` (ts: `tzBand`/`hiringStructure`); `profileRepo.update({ baseCountry, relocation, scheduleFlex, employmentPref })`. Consumed by Tasks 5, 6, 8.

- [ ] **Step 1: Write the failing repo test** — replace the `update()` cases in `src/server/persistence/repos/profile.test.ts` seeds to include the dials, and add:

```ts
it("update() sets scheduleFlex and employmentPref", async () => {
  const db = await createTestDb();
  await db.insert(profile).values({
    id: "default", baseCountry: "MY", relocation: "stay",
    scheduleFlex: "any-hours", employmentPref: "any",
  });
  const repo = createProfileRepo(db);
  const updated = await repo.update({
    baseCountry: "MY", relocation: "stay",
    scheduleFlex: "flex-evenings", employmentPref: "employee",
  });
  expect(updated.scheduleFlex).toBe("flex-evenings");
  expect(updated.employmentPref).toBe("employee");
});
```

(Also update the existing `db.insert(profile).values({...})` calls in this file — and every other bare-insert site found via `grep -rn "insert(profile)" src` (the shared `__fixtures__/helpers.ts` + `route.test.ts`) — to include `scheduleFlex: "any-hours", employmentPref: "any"`. NOT-NULL columns break bare inserts; the shared fixture must be fixed here or every jobsFeed/repo test fails at Step 7.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/persistence/repos/profile.test.ts` → FAIL (unknown column / type error).

- [ ] **Step 3: Extend the Drizzle schema** — `src/server/persistence/schema.ts`. In `profile` (after L88 `relocation`):

```ts
  scheduleFlex: text("schedule_flex", { enum: ["base-hours", "flex-evenings", "any-hours"] }).notNull(),
  employmentPref: text("employment_pref", { enum: ["any", "employee", "local-entity"] }).notNull(),
```

In `jobs` (after L136 `eligibilityEvidence`):

```ts
  // Spec 2026-07-14 §6: stated remote-fit facts. NULL = nothing stated (never
  // hidden by the schedule/structure gate). tz_band is normalized from a
  // stated TZ requirement (resolveTzBand); hiring_structure is stated-only.
  tzBand: text("tz_band", { enum: ["apac", "emea", "americas"] }),
  hiringStructure: text("hiring_structure", { enum: ["local-entity", "eor", "contractor"] }),
```

- [ ] **Step 4: Generate the migration** — `npm run db:generate`. It emits `drizzle/0008_<slug>.sql`. **Hand-edit it** so the profile columns are safe on a populated table (mirror `drizzle/0005_good_stellaris.sql`); the final SQL must read:

```sql
ALTER TABLE "profile" ADD COLUMN "schedule_flex" text NOT NULL DEFAULT 'any-hours';--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "employment_pref" text NOT NULL DEFAULT 'any';--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "schedule_flex" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "employment_pref" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "tz_band" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "hiring_structure" text;
```

(The temp default backfills the existing `default` profile row to the permissive dials, then is dropped so future inserts must be explicit — no runtime default. `jobs` columns stay nullable, no backfill.)

- [ ] **Step 5: Seed the permissive dials** — `src/server/persistence/seed.ts:57-61`, extend `profileSeed`:

```ts
export const profileSeed: typeof profile.$inferInsert = {
  id: "default",
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "any-hours",
  employmentPref: "any",
};
```

Apply the same two fields to `seedTestProfile` in `src/server/persistence/seed-test.ts`.

- [ ] **Step 6: Widen the repo** — `src/server/persistence/repos/profile.ts:27-31`:

```ts
async update(input: {
  baseCountry: string; relocation: "stay" | "open";
  scheduleFlex: "base-hours" | "flex-evenings" | "any-hours";
  employmentPref: "any" | "employee" | "local-entity";
}): Promise<ProfileRow> {
  const [row] = await db
    .update(profile)
    .set({
      baseCountry: input.baseCountry, relocation: input.relocation,
      scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref,
      updatedAt: sql`now()`,
    })
    .where(eq(profile.id, SINGLETON_ID))
    .returning();
  if (!row) throw new ProfileMissingError();
  return row;
}
```

- [ ] **Step 7: Run tests to verify they pass** — `npx vitest run src/server/persistence/repos/profile.test.ts src/server/persistence/seed.test.ts` → PASS. Then `npx vitest run src/server/search/jobsFeed.test.ts` → PASS (**the no-op proof:** permissive seed emits no gate condition, feed unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/server/persistence/schema.ts drizzle/ src/server/persistence/seed.ts src/server/persistence/seed-test.ts src/server/persistence/repos/profile.ts src/server/persistence/repos/profile.test.ts
git commit -m "feat(remote-fit): profile dial columns + nullable jobs tz_band/hiring_structure + permissive seed"
```

---

## Task 3: Extraction — required-nullable emission schema + jd-extract facts (Layer-C liveness fix)

**Goal:** All jd-extract LLM calls (scanned path + url-check gate) use an emission schema where every fact field is required-but-nullable so gpt-oss-120b actually emits `tzRequirement`/`hiringStructure`/`workCalendar`; the tolerant parse-side `JdFacts` type is unchanged; and one live 3/3 call confirms the new fields come back.

**Subagent:** **Sonnet (`executor`)** builds the schema/template/tests. **Review gate: Fable (deep-thinker)** — D1 is settled (do NOT touch `policyVersion`; see Resolved Decisions). The reviewer audits the exact `.optional()`→required-nullable transform and the null-strip boundary (the load-bearing lesson from memory `project-llm-schema-required-lesson`). The **live 3/3 verification** uses the repo `verify` skill (real LLM call), not a unit test.

**Files:**
- Modify: `src/server/score/jdFacts.ts` (`JdFactsSchema` +3 fields, `JdFactsEmitSchema`, `emitToFacts`, both `extract*` callers; delete `JdFactsGateSchema`)
- Modify: `config/templates/jd-extract.md`
- Modify/Test: `src/server/score/jdFacts.test.ts` (migrate the `JdFactsGateSchema` describe block at L83-108)
- Verify unchanged: `src/server/url-check/run.ts` (still calls `extractJdFactsForGate`, gate logic intact)
- **Do NOT touch** `src/lib/llm/templates.ts` or the policyVersion guard test (`jdFacts.test.ts:110-118`) — D1 resolved to no-bump; that test must stay green.

**Interfaces:**
- Produces: `JdFacts` (parse-side, tolerant) gains optional `tzRequirement?: string`, `hiringStructure?: "local-entity"|"eor"|"contractor"`, `workCalendar?: string`; `JdFactsEmitSchema` (every field present — scalars + `hiringScope`/`hiringCountries` + the 3 new fields **nullable**, `title` + the four arrays **non-nullable**) as `responseSchema` for both callers; `emitToFacts(emit: JdFactsEmit): JdFacts` strips nulls→undefined at the boundary (preserves the tolerant type + the url-check gate's `!company` semantics). Consumed by Tasks 4, 5, 7.

- [ ] **Step 1: Write the failing schema test** — in `src/server/score/jdFacts.test.ts`:

```ts
import { JdFactsSchema, JdFactsEmitSchema, emitToFacts } from "./jdFacts";

// title + the four arrays are required parse-side — every fixture must include them.
const BASE = { title: "Engineer", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] };

describe("JdFacts remote-fit fields", () => {
  it("parse-side JdFactsSchema tolerates omitted remote-fit fields (cheap-model omission is safe)", () => {
    const parsed = JdFactsSchema.parse({ ...BASE, isJobPosting: true, company: "Acme" });
    expect(parsed.tzRequirement).toBeUndefined();
  });
  it("emission schema requires every field present (scalars nullable, arrays + title non-null)", () => {
    expect(() => JdFactsEmitSchema.parse({ ...BASE, isJobPosting: true })).toThrow(); // company missing
    const ok = JdFactsEmitSchema.parse({
      title: "Engineer", isJobPosting: true, company: null,
      seniority: null, employmentType: null, location: null, remotePolicy: null,
      hiringScope: null, hiringCountries: null, salaryRange: null,
      mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [],
      tzRequirement: null, hiringStructure: null, workCalendar: null,
    });
    expect(ok.tzRequirement).toBeNull();
  });
  it("emitToFacts strips nulls to undefined (tolerant JdFacts + gate !company preserved)", () => {
    const facts = emitToFacts({
      title: "Engineer", isJobPosting: true, company: null,
      seniority: null, employmentType: null, location: null, remotePolicy: null,
      hiringScope: null, hiringCountries: null, salaryRange: null,
      mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [],
      tzRequirement: "4h overlap with PST", hiringStructure: null, workCalendar: null,
    });
    expect(facts.company).toBeUndefined();          // the url-check gate's !company stays true
    expect(facts.tzRequirement).toBe("4h overlap with PST");
    expect(facts.hiringStructure).toBeUndefined();
  });
  it("emission schema rejects an invalid hiringStructure enum", () => {
    expect(() => JdFactsEmitSchema.parse({ ...BASE, isJobPosting: true, company: null, hiringStructure: "b2b" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/score/jdFacts.test.ts` → FAIL (`JdFactsEmitSchema` not exported, new fields absent).

- [ ] **Step 3: Extend the parse-side schema + build the emission schema + the null-strip boundary** — in `src/server/score/jdFacts.ts`.

Add the three new fields to `JdFactsSchema` (tolerant, `.optional()` — matching the existing scalar fields; `emitToFacts` strips nulls, so `.optional()` never sees a `null`):

```ts
  tzRequirement: z.string().optional(),                                   // verbatim stated TZ/overlap requirement
  hiringStructure: z.enum(["local-entity", "eor", "contractor"]).optional(),
  workCalendar: z.string().optional(),                                    // stated calendar expectation (display-only)
```

Build one emission schema — **every field present**. The currently-`.optional()` scalars + `hiringScope`/`hiringCountries` + the three new fields become **required-nullable**; `title` and the four required arrays (`mustHaves`, `niceToHaves`, `responsibilities`, `redFlags`) stay **required-non-nullable** (the model already emits them; nullable arrays would invite `null` arrays); `isJobPosting` is required-non-nullable (the gate depends on it), per the `JdFactsGateSchema` precedent:

```ts
// gpt-oss-120b drops `.optional()` fields from json_schema output regardless of
// prompt wording (client.ts derives `required` from the Zod schema, strict:false).
// The emission schema forces every field present; emitToFacts then strips nulls
// back to undefined so the tolerant JdFactsSchema type is preserved.
export const JdFactsEmitSchema = z.object({
  title: z.string(),
  isJobPosting: z.boolean(),
  company: z.string().nullable(),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  location: z.string().nullable(),
  remotePolicy: z.string().nullable(),
  hiringScope: z.enum(["anywhere", "restricted"]).nullable(),
  hiringCountries: z.array(z.string()).nullable(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().nullable(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()),
  tzRequirement: z.string().nullable(),
  hiringStructure: z.enum(["local-entity", "eor", "contractor"]).nullable(),
  workCalendar: z.string().nullable(),
});
export type JdFactsEmit = z.infer<typeof JdFactsEmitSchema>;

// Null-strip boundary: emission output -> tolerant JdFacts. Dropping null-valued
// keys makes them `undefined`, which the `.optional()` parse-side fields accept
// (Zod `.optional()` rejects `null`), and keeps the url-check gate's `!company`
// check working when the model emits company: null.
export function emitToFacts(emit: JdFactsEmit): JdFacts {
  const stripped = Object.fromEntries(Object.entries(emit).filter(([, v]) => v !== null));
  return JdFactsSchema.parse(stripped);
}
```

Point **both** `extractJdFacts` and `extractJdFactsForGate` at `responseSchema: JdFactsEmitSchema` and return `emitToFacts(raw.data)` — both keep returning `JdFacts`, and `isJobPosting` is always present, so the gate's `data.isJobPosting === false` check still holds. `JdFactsGateSchema` is now subsumed: delete it, migrate its describe block (`jdFacts.test.ts:83-108`) onto `JdFactsEmitSchema`, and confirm `src/server/url-check/run.ts` (which calls `extractJdFactsForGate`) needs no gate-logic change (it reads `.isJobPosting`/`.company`, both intact).

- [ ] **Step 4: Extend the template** — `config/templates/jd-extract.md`, under the existing "stated only — do not guess" instruction, add:

```
- tzRequirement: the verbatim stated timezone/overlap requirement if any ("4h overlap with PST", "EU working hours"), else null. Timezone/overlap requirements go HERE, not in hiringCountries — geography and schedule are separate facts.
- hiringStructure: "local-entity" | "eor" | "contractor" | null. Cues: "via Deel/EOR" -> eor; "B2B contract" / "independent contractor" -> contractor; "our local entity" / "direct employment" -> local-entity. The ONLY sanctioned inference: an explicitly contract-term role ("12-month contract") -> contractor. Otherwise null.
- workCalendar: verbatim stated calendar expectation ("US public holidays") if any, else null. Display-only.
```

- [ ] **Step 5: Run the unit tests** — `npx vitest run src/server/score/jdFacts.test.ts` → PASS. The policyVersion invariance guard (`jdFacts.test.ts:110-118`) must remain **unchanged and green** (D1 = no-bump).

- [ ] **Step 6: Live 3/3 verification (verify skill, not a unit test).** Boot per the repo `verify` skill and run jd-extract against a real posting that states a TZ requirement (e.g. "Remote — 4h overlap with PST required"). Confirm across 3 live calls that `tzRequirement`, `hiringStructure`, `workCalendar` are all present (non-omitted) in the raw model output. Record the 3/3 result in the commit message. **Until this passes, the gates stay dark (the permissive seed guarantees no harm).**

- [ ] **Step 7: Commit**

```bash
git add src/server/score/jdFacts.ts src/server/score/jdFacts.test.ts config/templates/jd-extract.md
git commit -m "feat(remote-fit): required-nullable jd-extract emission schema + tz/structure/calendar facts [live 3/3 verified]"
```

---

## Task 4: Normalization — `resolveTzBand` pure resolver + gate mappings

**Goal:** A pure `resolveTzBand` normalizes a stated TZ requirement (authority) or a location-string token (fallback) into `apac|emea|americas`, returning `null` + a `console.warn` log for ambiguous (`"CST"`/`"IST"`) or unmapped stated tokens, plus the non-logging `probeTzToken` and the pure `allowedBandsFor`/`allowedStructuresFor` helpers the gate needs.

**Subagent:** **Sonnet (`executor`)** — a pure, table-driven function with an exhaustive unit table; well-specified, no design latitude. Review gate: Fable (inline) — confirm no branch guesses a band and the CST-ambiguity log matches the `eligibility.ts:86` precedent.

**Files:**
- Create: `src/server/score/tzBand.ts`
- Create: `src/server/score/tzBand.test.ts`

**Interfaces:**
- Consumes: `TzBand`/`ScheduleFlex`/`EmploymentPref`/`HiringStructure` string sets.
- Produces:
  - `resolveTzBand(args: { statedTz?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null` — logs on ambiguous/unmapped stated tokens
  - `probeTzToken(text: string, source: "stated" | "location"): TzBand | null` — **non-logging** pure lookup (the recompute scavenge uses it so ordinary country names never flood the drift log)
  - `allowedBandsFor(flex: ScheduleFlex): TzBand[] | null` — `null` = all allowed (no gate condition)
  - `allowedStructuresFor(pref: EmploymentPref): HiringStructure[] | null` — `null` = all allowed
  - Consumed by Tasks 5 (write points) and 6 (feed predicate).

- [ ] **Step 1: Write the failing test** — `src/server/score/tzBand.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveTzBand, probeTzToken, allowedBandsFor, allowedStructuresFor } from "./tzBand";

describe("resolveTzBand token table", () => {
  const cases: [string, "apac" | "emea" | "americas"][] = [
    ["4h overlap with PST", "americas"], ["US working hours", "americas"], ["North America", "americas"],
    ["CET", "emea"], ["EU working hours", "emea"], ["GMT/BST", "emea"],
    ["SGT", "apac"], ["APAC hours", "apac"], ["AEST", "apac"],
  ];
  it.each(cases)("statedTz %s -> %s", (statedTz, band) => {
    expect(resolveTzBand({ statedTz }).band).toBe(band);
  });
  it("bare CST is ambiguous (US Central vs China) -> null + warn (never a band)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "CST" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("bare IST is ambiguous (India/Israel/Ireland) -> null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "IST" })).toBeNull();
    warn.mockRestore();
  });
  it("unmapped stated token -> null + warn (curated-map drift signal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "Klingon Standard Time" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("statedTz (authority) wins over location", () => {
    expect(resolveTzBand({ statedTz: "PST", location: "Remote (CET)" }).band).toBe("americas");
  });
  it("falls back to a location token when statedTz absent", () => {
    expect(resolveTzBand({ location: "Remote — EST hours" }).band).toBe("americas");
  });
  // Trust-killer guard (spec §14.2): a bare 2-letter country code in a LOCATION
  // string must never map to a band. "PT"/"ET" are stated-source-only tokens.
  it("bare country code PT in a location string does NOT map (Lisbon, PT)", () => {
    expect(resolveTzBand({ location: "Lisbon, PT" })).toBeNull();
  });
  it("nothing stated -> null (no guess, no log)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("probeTzToken (non-logging, for recompute scavenge)", () => {
  it("returns a band without logging, and null for ordinary country names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(probeTzToken("PST", "stated")).toBe("americas");
    expect(probeTzToken("United States", "stated")).toBeNull(); // ordinary country name -> no band, no log
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("gate mappings", () => {
  it("allowedBandsFor: base-hours admits only apac; flex-evenings apac+emea; any-hours all (null)", () => {
    expect(allowedBandsFor("base-hours")).toEqual(["apac"]);
    expect(allowedBandsFor("flex-evenings")).toEqual(["apac", "emea"]);
    expect(allowedBandsFor("any-hours")).toBeNull();
  });
  it("allowedStructuresFor: employee admits local-entity+eor; local-entity admits only itself; any -> null", () => {
    expect(allowedStructuresFor("employee")).toEqual(["local-entity", "eor"]);
    expect(allowedStructuresFor("local-entity")).toEqual(["local-entity"]);
    expect(allowedStructuresFor("any")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/score/tzBand.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/server/score/tzBand.ts`** (mirror `eligibility.ts` structure — pure, curated tables, log-never-guess):

```ts
import type { TzBand, ScheduleFlex, EmploymentPref, HiringStructure } from "@/types";

// Curated token -> band. Bands are coarse by design (spec §5): overlap-hour
// arithmetic is deliberately dropped.
// SAFE tokens (3+ letters or region words, case-insensitive) are checked in BOTH
// a stated requirement and a location string. STATED_ONLY tokens are bare 2-letter
// abbreviations that collide with country codes ("PT"=Portugal, "ET"=Ethiopia) —
// trusted only inside an explicit stated TZ requirement, never a location string
// (spec §14.2 trust-killer guard: "Lisbon, PT" must not map to Americas).
const SAFE_TOKENS: [RegExp, TzBand][] = [
  [/\b(PST|PDT|MST|MDT|EST|EDT|US ?hours|US working hours|north america|latam|americas)\b/i, "americas"],
  [/\b(CET|CEST|GMT|BST|UTC|EU ?hours|EU working hours|emea|europe)\b/i, "emea"],
  [/\b(SGT|MYT|AEST|AEDT|JST|APAC ?hours|APAC|asia)\b/i, "apac"],
];
const STATED_ONLY_TOKENS: [RegExp, TzBand][] = [
  [/\b(ET|PT)\b/, "americas"], // case-sensitive uppercase; stated source only
];
// Ambiguous, never guessed (spec §5): CST = US Central vs China Standard;
// IST = India vs Israel vs Ireland.
const AMBIGUOUS = /\b(CST|IST)\b/i;

const SCHEDULE_ORDER: ScheduleFlex[] = ["base-hours", "flex-evenings", "any-hours"];
const BAND_MIN_FLEX: Record<TzBand, ScheduleFlex> = {
  apac: "base-hours",
  emea: "flex-evenings",
  americas: "any-hours",
};

// Pure, NON-logging lookup. The recompute scavenge (Task 5) calls this over every
// hiringCountries entry, so it must stay silent on ordinary country names.
export function probeTzToken(text: string, source: "stated" | "location"): TzBand | null {
  if (AMBIGUOUS.test(text)) return null;
  for (const [re, band] of SAFE_TOKENS) if (re.test(text)) return band;
  if (source === "stated") for (const [re, band] of STATED_ONLY_TOKENS) if (re.test(text)) return band;
  return null;
}

export function resolveTzBand(args: { statedTz?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null {
  // Precedence: JD-stated requirement (authority) -> location-string token.
  const sources: [string, "stated" | "location", string | null | undefined][] = [
    ["JD", "stated", args.statedTz],
    ["location", "location", args.location],
  ];
  for (const [label, source, text] of sources) {
    if (!text) continue;
    if (AMBIGUOUS.test(text)) {
      console.warn(`tzBand: ambiguous timezone token, not mapped: "${text}"`);
      return null;
    }
    const band = probeTzToken(text, source);
    if (band) return { band, evidence: `${label}: ${text}` };
    // A non-empty STATED requirement we couldn't map is a drift signal; an
    // unmapped location string is ordinary (most locations carry no TZ token).
    if (source === "stated") {
      console.warn(`tzBand: unmapped timezone requirement: "${text}"`);
      return null;
    }
  }
  return null; // nothing mapped -> no band
}

export function allowedBandsFor(flex: ScheduleFlex): TzBand[] | null {
  const idx = SCHEDULE_ORDER.indexOf(flex);
  if (idx === SCHEDULE_ORDER.length - 1) return null; // any-hours admits every band
  // A band is allowed iff its minimum required flex is <= the user's flex.
  return (Object.keys(BAND_MIN_FLEX) as TzBand[]).filter(
    (b) => SCHEDULE_ORDER.indexOf(BAND_MIN_FLEX[b]) <= idx,
  );
}

export function allowedStructuresFor(pref: EmploymentPref): HiringStructure[] | null {
  if (pref === "any") return null;
  if (pref === "employee") return ["local-entity", "eor"];
  return ["local-entity"]; // pref === "local-entity"
}
```

> `TzBand`/`HiringStructure` types: add to `src/types/index.ts` in Task 1's follow-up **or** define them here if not needed by the wire contract. Decision: the columns are DB-only (spec §3 "zero new Job fields"), so define `export type TzBand = "apac"|"emea"|"americas"` and `export type HiringStructure = "local-entity"|"eor"|"contractor"` in `src/types/index.ts` as bare TS types (no Zod) next to the enums — they are shared vocabulary, not wire fields. Add that in this task's Step 3 and re-run `npm run contract:check` (bare types don't alter openapi).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/server/score/tzBand.test.ts` → PASS.

- [ ] **Step 5: Doc ripple** — add `resolveTzBand` + the band tables to `docs/architecture/system-architecture.md` beside the eligibility resolver description.

- [ ] **Step 6: Commit**

```bash
git add src/server/score/tzBand.ts src/server/score/tzBand.test.ts src/types/index.ts docs/architecture/system-architecture.md
git commit -m "feat(remote-fit): pure resolveTzBand + band/structure gate mappings"
```

---

## Task 5: Write points — ingest stamp, authoritative score-path refresh, recompute

**Goal:** Ingest stamps `tz_band` from the location string (Layer-B); the scoring path authoritatively writes `tz_band` (from `tzRequirement`, else location) and `hiring_structure` (stated enum); and the pure recompute script re-derives `tz_band` from stored `jd_facts` (incl. scavenging TZ tokens misfiled in `hiringCountries`) with zero LLM cost.

**Subagent:** **Sonnet (`executor`)** — follows the eligibility write-point pattern precisely (three known call sites + recompute). Review gate: Fable (inline) — confirm the score-path refresh order matches the eligibility write and that recompute writes only on change.

**Files:**
- Modify: `src/server/persistence/repos/jobs.ts` (new `updateRemoteFit` beside `updateEligibility` L209-216)
- Modify: `src/server/search/run.ts` (`upsertMatchedPostings` ~L322-363 ingest stamp; **and** the top-N pool filter L385-387 scan-hardening rider)
- Modify: `src/server/score/index.ts` (`scoreJob` ~L53-66, refresh)
- Modify: `src/server/score/recompute-eligibility.ts` (extend to `tz_band`)
- Test: `src/server/persistence/repos/jobs.test.ts`, `src/server/score/scoreJob.test.ts`

**Interfaces:**
- Consumes: `resolveTzBand`/`probeTzToken`/`allowedBandsFor` (Task 4), `JdFacts.tzRequirement`/`hiringStructure` (Task 3), `profile.scheduleFlex` (Task 2), `jobs.tzBand`/`hiringStructure` columns (Task 2).
- Produces: `jobsRepo.updateRemoteFit(id: string, tzBand: TzBand | null, hiringStructure: HiringStructure | null): Promise<void>`. Consumed by the feed predicate (Task 6) via the persisted columns.

- [ ] **Step 1: Write the failing repo test** — in `src/server/persistence/repos/jobs.test.ts`:

```ts
it("updateRemoteFit sets tz_band and hiring_structure", async () => {
  const db = await createTestDb();
  const repo = createJobsRepo(db);
  const id = await seedOneJob(db, { eligibility: "eligible" }); // existing helper pattern
  await repo.updateRemoteFit(id, "americas", "contractor");
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  expect(row.tzBand).toBe("americas");
  expect(row.hiringStructure).toBe("contractor");
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/persistence/repos/jobs.test.ts` → FAIL (`updateRemoteFit` undefined).

- [ ] **Step 3: Add the repo write** — `src/server/persistence/repos/jobs.ts`, beside `updateEligibility`:

```ts
async updateRemoteFit(id: string, tzBand: JobRow["tzBand"], hiringStructure: JobRow["hiringStructure"]): Promise<void> {
  const [row] = await db
    .update(jobs)
    .set({ tzBand, hiringStructure })
    .where(eq(jobs.id, id))
    .returning({ id: jobs.id });
  if (!row) throw new Error(`jobsRepo.updateRemoteFit: no job with id "${id}"`);
},
```

- [ ] **Step 4: Score-path refresh** — `src/server/score/index.ts`, immediately after the `updateEligibility` call (~L66), add:

```ts
const tz = resolveTzBand({ statedTz: jdFactsResult.data.tzRequirement, location: job.location || undefined });
await jobsRepo.updateRemoteFit(job.id, tz?.band ?? null, jdFactsResult.data.hiringStructure ?? null);
```

(import `resolveTzBand` from `@/server/score/tzBand`.)

- [ ] **Step 5: Ingest stamp** — `src/server/search/run.ts`, in `upsertMatchedPostings` where the row is built for `upsertByDedupeKey`, derive the ingest-time band from the location string only (no jd_facts yet) and include it in the insert values:

```ts
const tzIngest = resolveTzBand({ location: canonical.location });
// ... include in the upsert values: tzBand: tzIngest?.band ?? null, hiringStructure: null,
```

Match the exact insert-shape at the existing `eligibility`/`eligibilityEvidence` stamp (~L355-356). `hiring_structure` is never derivable from a location string → `null` at ingest, populated by the score path.

- [ ] **Step 5b: Scan-hardening pool filter (spec §6 rider)** — `src/server/search/run.ts:385-387`. A posting provably outside the schedule dial should not consume a top-N LLM scoring slot (persisted, unscored — exactly like `abroad` under `stay`). Replace:

```ts
const pool = profile.relocation === "stay" ? candidates.filter((c) => c.job.eligibility !== "abroad") : candidates;
```

with:

```ts
const allowedBands = allowedBandsFor(profile.scheduleFlex); // null = all bands allowed
const pool = candidates.filter((c) => {
  if (profile.relocation === "stay" && c.job.eligibility === "abroad") return false;
  if (allowedBands && c.job.tzBand && !allowedBands.includes(c.job.tzBand)) return false; // NULL band always passes
  return true;
});
```

(import `allowedBandsFor` from `@/server/score/tzBand`. `hiring_structure` is always `NULL` at ingest, so band is the only scan-time gate; the structure gate applies only at feed-read.)

- [ ] **Step 6: Extend recompute** — `src/server/score/recompute-eligibility.ts`, inside the per-job loop after the eligibility recompute, re-derive `tz_band` from stored `jd_facts`. `jdFacts` is read as the existing `as JdFacts | undefined` cast (recompute precedent). Scavenge a TZ token misfiled in `hiringCountries` with the **non-logging** `probeTzToken` — `resolveTzBand` would emit an "unmapped requirement" warn for every ordinary country name on every recompute:

```ts
// import { resolveTzBand, probeTzToken } from "@/server/score/tzBand";
const statedTz = jdFacts?.tzRequirement
  ?? (jdFacts?.hiringCountries ?? []).find((c: string) => probeTzToken(c, "stated") !== null)
  ?? null;
const tz = resolveTzBand({ statedTz, location: job.location || undefined });
const nextBand = tz?.band ?? null;
if (nextBand !== job.tzBand) {
  await db.update(jobs).set({ tzBand: nextBand }).where(eq(jobs.id, job.id));
  tzChanged += 1;
}
```

Extend the returned `{ total, changed }` to also report `tzChanged` and the final log line.

- [ ] **Step 7: Write + run the refresh test** — in `src/server/score/scoreJob.test.ts`, add a case asserting that scoring a job whose jd-extract returns `tzRequirement: "PST"` + `hiringStructure: "contractor"` writes `tzBand: "americas"` / `hiringStructure: "contractor"` on the row. Run `npx vitest run src/server/score/scoreJob.test.ts src/server/persistence/repos/jobs.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/persistence/repos/jobs.ts src/server/search/run.ts src/server/score/index.ts src/server/score/recompute-eligibility.ts src/server/persistence/repos/jobs.test.ts src/server/score/scoreJob.test.ts
git commit -m "feat(remote-fit): stamp/refresh/recompute tz_band + hiring_structure (write points)"
```

---

## Task 6: Feed predicate — three-gate composition + generalized excluded count

**Goal:** The feed hides a row when its stated `tz_band` demands more than `scheduleFlex` OR its stated `hiring_structure` conflicts with `employmentPref` (geography gate unchanged); `NULL` columns always pass; the pasted scope stays exempt; `stats.excluded` counts all three gates; and the permissive seed yields a byte-identical feed (no-op proof).

**Subagent:** **Sonnet (`executor`)** — extends the existing `inArray` predicate + count with two `OR(isNull, inArray)` conditions; bounded and pattern-matched. Review gate: Fable (inline) — verify the generalized hidden-count ORs the three sub-predicates (not ANDs) and the pasted exemption still short-circuits all three.

**Files:**
- Modify: `src/server/search/jobsFeed.ts` (`listJobsFeed` L42-78)
- Modify: `src/server/persistence/repos/jobs.ts` (`buildFilterConditions` L62, `listScored`, `countHiddenByEligibility` → generalized)
- Modify: `src/caliber-ui/compositions/Feed/SummaryStrip.tsx:22`
- Test: `src/server/persistence/repos/jobs.test.ts`, `src/server/search/jobsFeed.test.ts`, `src/app/api/jobs/route.test.ts`

**Interfaces:**
- Consumes: `allowedBandsFor`/`allowedStructuresFor` (Task 4), `profile.scheduleFlex`/`employmentPref` (Task 2), `jobs.tzBand`/`hiringStructure` (Task 2).
- Produces: extended `JobsQuery` with `tzBands?: TzBand[]` and `hiringStructures?: HiringStructure[]`; a generalized hidden-count. Consumed by the route + strip.

- [ ] **Step 1: Write the failing predicate test** — in `src/server/persistence/repos/jobs.test.ts`:

```ts
it("filters by tzBands: NULL passes, listed bands pass, others hidden", async () => {
  const db = await createTestDb(); const repo = createJobsRepo(db);
  await seedOneJob(db, { tzBand: null });        // passes (unstated)
  await seedOneJob(db, { tzBand: "apac" });      // passes (allowed)
  await seedOneJob(db, { tzBand: "americas" });  // hidden
  const { items } = await repo.listScored({ tzBands: ["apac"] });
  expect(items).toHaveLength(2);
});
it("filters by hiringStructures: NULL passes, listed pass, others hidden", async () => {
  const db = await createTestDb(); const repo = createJobsRepo(db);
  await seedOneJob(db, { hiringStructure: null });
  await seedOneJob(db, { hiringStructure: "eor" });
  await seedOneJob(db, { hiringStructure: "contractor" });
  const { items } = await repo.listScored({ hiringStructures: ["local-entity", "eor"] });
  expect(items).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/persistence/repos/jobs.test.ts` → FAIL.

- [ ] **Step 3: Extend `buildFilterConditions`** — `src/server/persistence/repos/jobs.ts`, after L62 (import `or`, `isNull` from `drizzle-orm`):

```ts
if (q.tzBands && q.tzBands.length > 0) conditions.push(or(isNull(jobs.tzBand), inArray(jobs.tzBand, q.tzBands)));
if (q.hiringStructures && q.hiringStructures.length > 0) conditions.push(or(isNull(jobs.hiringStructure), inArray(jobs.hiringStructure, q.hiringStructures)));
```

Add `tzBands?: TzBand[]` and `hiringStructures?: HiringStructure[]` to the `JobsQuery` type.

- [ ] **Step 4: Compose the gates in the read model** — `src/server/search/jobsFeed.ts`, after reading `profile` (L42), replace the single `eligibility` scope build (L53-56) with all three dials:

```ts
const eligibility = !isPastedScope && profile.relocation === "stay" ? STAY_TIERS : undefined;
const tzBands = !isPastedScope ? (allowedBandsFor(profile.scheduleFlex) ?? undefined) : undefined;
const hiringStructures = !isPastedScope ? (allowedStructuresFor(profile.employmentPref) ?? undefined) : undefined;
const filterScope = { ...rest, isNew: isNewFilter, eligibility, tzBands, hiringStructures };
```

- [ ] **Step 5: Generalize the excluded count** — replace `countHiddenByEligibility` usage (L69-72) with a `countHidden` that ORs the three hidden sets. Add to `jobs.ts`:

```ts
async countHidden(
  q: Omit<JobsQuery, "cursor" | "limit" | "tier" | "minScore" | "eligibility" | "tzBands" | "hiringStructures">,
  hidden: { tiers?: EligibilityTier[]; bands?: TzBand[]; structures?: HiringStructure[] },
): Promise<number> {
  const scope = buildFilterConditions(q); // persona/q/isNew only (q here omits the gate keys)
  const gates = [];
  if (hidden.tiers?.length) gates.push(inArray(jobs.eligibility, hidden.tiers));
  if (hidden.bands?.length) gates.push(inArray(jobs.tzBand, hidden.bands));
  if (hidden.structures?.length) gates.push(inArray(jobs.hiringStructure, hidden.structures));
  if (gates.length === 0) return 0;
  const rows = await db.select({ id: jobs.id }).from(jobs).where(and(...scope, or(...gates)));
  return rows.length;
}
```

In `jobsFeed.ts`, compute the hidden sets as the complements the gate hides (bands: `allBands − allowedBands`; structures: `allStructures − allowedStructures`; tiers: `HIDDEN_TIERS` when `stay`) and call `countHidden`. Keep `countHiddenByEligibility` only if still referenced elsewhere (grep first); otherwise remove it.

- [ ] **Step 6: Generalize the strip label** — `src/caliber-ui/compositions/Feed/SummaryStrip.tsx:22`:

```ts
{ label: "Excluded · outside your remote preferences", value: stats.excluded },
```

- [ ] **Step 7: Write the route-level flip test** — in `src/app/api/jobs/route.test.ts`, add a journey mirroring the existing stay/open flip: seed one `tz_band: "americas"` job + one `tz_band: "apac"` job with a `scheduleFlex: "base-hours"` profile → feed shows 1, `excluded` = 1; update profile to `scheduleFlex: "any-hours"` → feed shows 2, `excluded` = 0. Run `npx vitest run src/app/api/jobs/route.test.ts src/server/search/jobsFeed.test.ts src/server/persistence/repos/jobs.test.ts` → PASS.

- [ ] **Step 8: Doc ripple** — amend the feed-predicate prose in `docs/architecture/api-contract.md:227` and `docs/architecture/system-architecture.md` to the three-gate composition.

- [ ] **Step 9: Commit**

```bash
git add src/server/search/jobsFeed.ts src/server/persistence/repos/jobs.ts src/caliber-ui/compositions/Feed/SummaryStrip.tsx src/app/api/jobs/route.test.ts src/server/search/jobsFeed.test.ts src/server/persistence/repos/jobs.test.ts docs/architecture/api-contract.md docs/architecture/system-architecture.md
git commit -m "feat(remote-fit): three-gate feed predicate + generalized excluded count"
```

---

## Task 7: Row pills + detail panel

**Goal:** `assembleJob` pushes a schedule pill ("US hours"/"EU hours", `apac` suppressed) and a structure pill ("Contractor"/"EOR"/"Local entity", stated-only) into `Job.tags`, and `workCalendar` renders in the detail gaps panel — reusing the existing `Tag` primitive, no new primitives.

**Subagent:** **Sonnet (`executor`)** — assembler + `JobRow` render + DOM tests, existing `Tag` pattern. Review gate: Fable (inline) — D2 is settled (pills ride `Job.tags` with `tone: "neutral"` + additive `title?`; see Resolved Decisions). Confirm `apac`/unstated suppression mirrors the eligibility-`local` precedent and that `JobRow` renders exactly the `neutral`-toned tags.

**Files:**
- Modify: `src/types/index.ts` — extend `Tone` with `"neutral"` (L16) **and** add `title?` to the `Job.tags` entry (L102); + `docs/architecture/api-contract.md` + regenerate `src/contract/openapi.json`
- Modify: `src/features/feed/assemble.ts` (tags array L59-61; `workCalendar` → gaps)
- Modify: `src/caliber-ui/compositions/Feed/JobRow.tsx` (render `neutral`-toned tags — it renders none today)
- Modify: `src/caliber-ui/compositions/Detail/JobDetail.tsx` (gaps panel L117-127 shows `workCalendar` automatically once appended; existing `tags.map` L70-72 gains the pills)
- Modify: `docs/architecture/component-inventory.md`
- Test: `src/features/feed/assemble.test.ts`, `src/caliber-ui/compositions/Feed/JobRow.dom.test.tsx`

**Interfaces:**
- Consumes: `jobs.tzBand`/`hiringStructure` on the joined row (from `JobJoinScore`); `score.jdFacts` cast `as JdFacts | undefined` (the column is `jsonb $type<unknown>`) for the verbatim `tzRequirement` tooltip + `workCalendar`.
- Produces: `neutral`-toned schedule/structure entries in `Job.tags` (with `title?`); the `Job.tags` entry gains optional `title`; wire `Tone` gains `"neutral"`.

- [ ] **Step 1: Extend the contract (two additive changes)** — `src/types/index.ts`:

```ts
export const Tone = z.enum(["verified", "good", "warn", "ghost", "danger", "neutral"]); // +neutral (UI TagTone already styles it)
// ...
tags: z.array(z.object({ tone: Tone, label: z.string(), title: z.string().optional() })), // +title for the verbatim tooltip
```

Mirror both in `api-contract.md`, run `npm run contract:check`, commit the regenerated `openapi.json`. Both are additive/backward-compatible (existing tags omit `title`; existing tones stay valid).

- [ ] **Step 2: Write the failing assembler test** — in `src/features/feed/assemble.test.ts` (the helper builds a `JobJoinScore`; put `tzRequirement` on the score's `jdFacts`):

```ts
it("appends a neutral schedule pill for a known non-apac band, with the verbatim tooltip; suppresses apac", () => {
  const a = assembleJob(joinWith({ tzBand: "americas" }, { jdFacts: { tzRequirement: "4h overlap with PST" } }), opts);
  const pill = a.tags.find((t) => t.label === "US hours");
  expect(pill?.tone).toBe("neutral");
  expect(pill?.title).toBe("4h overlap with PST");
  const b = assembleJob(joinWith({ tzBand: "apac" }, {}), opts);
  expect(b.tags.find((t) => t.label === "APAC hours")).toBeUndefined(); // suppressed
});
it("appends a structure pill only when stated", () => {
  const a = assembleJob(joinWith({ hiringStructure: "contractor" }, {}), opts);
  expect(a.tags.find((t) => t.label === "Contractor")?.tone).toBe("neutral");
  const b = assembleJob(joinWith({ hiringStructure: null }, {}), opts);
  expect(b.tags.some((t) => ["Contractor", "EOR", "Local entity"].includes(t.label))).toBe(false);
});
```

> The existing assembler test asserts the legitimacy tag is `tags[0]` — keep that; the new pills append **after** it. Relax any exact-array-equality assertion to `tags.find(...)`.

- [ ] **Step 3: Implement in `assembleJob`** — `src/features/feed/assemble.ts`. Keep the legitimacy tag at `tags[0]`; append the `neutral`-toned pills. `score.jdFacts` is `unknown` → cast via the `recompute-eligibility.ts:31` precedent, and type the array so `title` is allowed:

```ts
import type { JdFacts } from "@/server/score/jdFacts";
import type { Tone } from "@/types";
// inside assembleJob, after destructuring { job, score, source }:
const jdFacts = score.jdFacts as JdFacts | undefined;

const SCHEDULE_LABEL: Record<Exclude<TzBand, "apac">, string> = { emea: "EU hours", americas: "US hours" };
const STRUCTURE_LABEL: Record<HiringStructure, string> = { "local-entity": "Local entity", eor: "EOR", contractor: "Contractor" };

const tags: { tone: Tone; label: string; title?: string }[] = [{ tone, label: TIER_LABEL[tier] }];
if (job.tzBand && job.tzBand !== "apac") {
  // tone:"neutral" is the discriminator JobRow filters on; apac suppressed
  // (business-as-usual from MY, mirrors the eligibility "local" suppression).
  tags.push({ tone: "neutral", label: SCHEDULE_LABEL[job.tzBand], title: jdFacts?.tzRequirement });
}
if (job.hiringStructure) tags.push({ tone: "neutral", label: STRUCTURE_LABEL[job.hiringStructure] });
```

**Checkpoint:** confirm the feed/detail query selects `job_scores.jdFacts` onto the score row (grep the `listScored`/detail select in `jobs.ts`) — the tooltip + `workCalendar` depend on it. If it is not selected, add it; the band label itself still works from the `jobs.tzBand` column, so the pill degrades to no-tooltip rather than breaking.

- [ ] **Step 3b: Render the pills on the feed row** — `src/caliber-ui/compositions/Feed/JobRow.tsx:71-73` renders `<LegitimacyTag>` + `<EligibilityTag>` but **not** `Job.tags`. Render exactly the `neutral`-toned tags (legitimacy tones are always semantic, so this never duplicates the legitimacy pill):

```tsx
{job.tags.filter((t) => t.tone === "neutral").map((t) => (
  <Tag key={t.label} tone={t.tone} title={t.title}>{t.label}</Tag>
))}
```

(`JobDetail.tsx:70-72` already maps all of `job.tags`, so it gains the two pills automatically — no change there.)

- [ ] **Step 4: `workCalendar` in the detail gaps panel** — `Job` gains no new field; surface `workCalendar` by appending a `gaps` entry in `assembleJob` when stated, which `JobDetail.tsx:117-127` renders for free:

```ts
const gaps = jdFacts?.workCalendar
  ? [...score.gaps, { tone: "warn" as const, k: "Work calendar", v: jdFacts.workCalendar }]
  : score.gaps;
// ...return `gaps` on the assembled Job instead of `score.gaps`
```

Add an assembler test asserting the entry appears only when `workCalendar` is stated.

- [ ] **Step 5: Run tests** — add a JobRow DOM test (a `neutral` "US hours" tag renders on the row; none renders when `tzBand` is null or `apac`), then `npx vitest run src/features/feed/assemble.test.ts src/caliber-ui/compositions/Feed/JobRow.dom.test.tsx` → PASS.

- [ ] **Step 6: Doc ripple** — `docs/architecture/component-inventory.md`: schedule/structure pills on `JobRow`/`JobDetail`; wire `Tone` gained `"neutral"`.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/contract/openapi.json docs/architecture/api-contract.md src/features/feed/assemble.ts src/features/feed/assemble.test.ts src/caliber-ui/compositions/Feed/JobRow.tsx src/caliber-ui/compositions/Feed/JobRow.dom.test.tsx src/caliber-ui/compositions/Detail/JobDetail.tsx docs/architecture/component-inventory.md
git commit -m "feat(remote-fit): neutral-toned schedule/structure row pills + workCalendar detail row"
```

---

## Task 8: Profile page — preset row + schedule/employment controls

**Goal:** `/profile` grows a "Which sounds like you?" preset row (four archetype cards that set the dials) and two segmented controls (schedule, employment) in the existing sunken-pill style, saving on change via `PUT /api/profile`, with the dials as the only stored truth.

**Subagent:** **Sonnet (`executor`)** builds the composition + wiring + DOM tests. **Review gate: Fable (deep-thinker)** — UX judgment task: adjudicate the preset→dial mappings, the user-facing control captions, and the "presets are not state" behavior (a preset click sets the dials; the selected preset is derived, not stored).

**Files:**
- Modify: `src/caliber-ui/compositions/Profile/ProfileTargets.tsx`
- Modify: `src/app/profile/page.tsx`
- Modify: `src/features/profile/client.ts` (widen `updateProfile` input)
- Modify: `src/app/api/profile/route.ts` — `RequestBody = Profile.omit({updatedAt})` auto-derives the new fields, but **`toWire` (L18-26) explicitly builds the wire object and must add `scheduleFlex`/`employmentPref`**, else `Profile.parse` throws on every GET/PUT.
- Test: `src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx`, `src/app/api/profile/route.test.ts`

**Interfaces:**
- Consumes: `Profile.scheduleFlex`/`employmentPref` (Task 1), `profileRepo.update` widened (Task 2).
- Produces: `onScheduleChange(v: ScheduleFlex)` / `onEmploymentChange(v: EmploymentPref)` props on `ProfileTargets`; a preset-card row that calls all three change handlers together.

- [ ] **Step 1: Widen the client** — `src/features/profile/client.ts`, `updateProfile` input type → `{ baseCountry: string; relocation: RelocationPref; scheduleFlex: ScheduleFlex; employmentPref: EmploymentPref }`.

- [ ] **Step 2: Write the failing DOM test** — in `ProfileTargets.dom.test.tsx` (seed the profile object with the two dials):

```ts
const profile = { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any", updatedAt: "2026-07-14T00:00:00.000Z" } as const;

it("renders schedule + employment controls with current selection", () => {
  render(<ProfileTargets profile={profile} busy={false} onRelocationChange={()=>{}} onScheduleChange={()=>{}} onEmploymentChange={()=>{}} />);
  expect(screen.getByRole("button", { name: "Any hours — US overlap" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Any arrangement" })).toHaveAttribute("aria-pressed", "true");
});
it("clicking a schedule level calls onScheduleChange", () => {
  const onSchedule = vi.fn();
  render(<ProfileTargets profile={profile} busy={false} onRelocationChange={()=>{}} onScheduleChange={onSchedule} onEmploymentChange={()=>{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Malaysia hours" }));
  expect(onSchedule).toHaveBeenCalledWith("base-hours");
});
it("a preset card sets all three dials", () => {
  const onReloc = vi.fn(), onSchedule = vi.fn(), onEmployment = vi.fn();
  render(<ProfileTargets profile={profile} busy={false} onRelocationChange={onReloc} onScheduleChange={onSchedule} onEmploymentChange={onEmployment} />);
  fireEvent.click(screen.getByRole("button", { name: /Global remote/ }));
  expect(onReloc).toHaveBeenCalledWith("stay");
  expect(onSchedule).toHaveBeenCalledWith("flex-evenings");
  expect(onEmployment).toHaveBeenCalledWith("any");
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx` → FAIL.

- [ ] **Step 4: Implement `ProfileTargets`** — add two new `onScheduleChange`/`onEmploymentChange` props; render two more sunken-pill `Chip variant="filter"` groups (copy the Relocation block verbatim) with these option arrays + captions (user-terms, per spec §8):

```ts
const SCHEDULE_OPTIONS: { value: ScheduleFlex; label: string }[] = [
  { value: "base-hours", label: "Malaysia hours" },
  { value: "flex-evenings", label: "Evenings OK — Europe overlap" },
  { value: "any-hours", label: "Any hours — US overlap" },
];
const EMPLOYMENT_OPTIONS: { value: EmploymentPref; label: string }[] = [
  { value: "any", label: "Any arrangement" },
  { value: "employee", label: "Employee — EOR OK" },
  { value: "local-entity", label: "Malaysian entity only" },
];
```

Add the preset row on top ("Which sounds like you?") — four `Card interactive` tiles that call all three handlers with the bundle (spec §8):

```ts
const PRESETS = [
  { name: "Malaysia-only remote", dials: { relocation: "stay", scheduleFlex: "base-hours", employmentPref: "local-entity" } },
  { name: "Global remote",        dials: { relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" } },
  { name: "Digital nomad",        dials: { relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" } },
  { name: "Open to relocate",     dials: { relocation: "open", scheduleFlex: "flex-evenings", employmentPref: "any" } },
] as const;
```

Each preset tile onClick fires `onRelocationChange(dials.relocation); onScheduleChange(dials.scheduleFlex); onEmploymentChange(dials.employmentPref);`. Presets are **not stored** — the tile may show a derived "selected" ring when all three current dials equal its bundle, but nothing persists beyond the dials.

- [ ] **Step 5: Wire the page** — `src/app/profile/page.tsx`, add `handleScheduleChange`/`handleEmploymentChange` (mirror `handleRelocationChange`, passing all four current fields into `updateProfile`), plus a combined preset handler that PUTs the full bundle once. Pass the new props into `<ProfileTargets>`.

- [ ] **Step 6: Extend the route test** — `src/app/api/profile/route.test.ts`, seed the two dials in the insert, add a PUT case that flips `scheduleFlex` and asserts the returned Profile carries it. Run `npx vitest run src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx src/app/api/profile/route.test.ts` → PASS.

- [ ] **Step 7: Doc ripple** — `docs/architecture/component-inventory.md`: ProfileTargets preset row + two controls.

- [ ] **Step 8: Commit**

```bash
git add src/caliber-ui/compositions/Profile/ProfileTargets.tsx src/app/profile/page.tsx src/features/profile/client.ts src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx src/app/api/profile/route.test.ts docs/architecture/component-inventory.md
git commit -m "feat(remote-fit): profile preset row + schedule/employment dials"
```

---

## Task 9: E2E journey + validation-gate coverage + full-gate green

**Goal:** One Playwright journey proves the end-to-end behavior (flip the schedule dial on `/profile` → a US-hours job leaves the feed → excluded count moves), the §11 coverage script exists to measure band/structure coverage after a real scan, and `npm run check` + `npm run test:e2e` are green.

**Subagent:** **Sonnet (`executor`)** — E2E test + a ~20-line coverage script following the `eligibility-distribution.ts` precedent. Review gate: Fable (inline) — confirm the E2E asserts the excluded-count movement (the trust signal), not just row disappearance.

**Files:**
- Create: `e2e/remote-fit.spec.ts` (match the repo's existing E2E dir/naming)
- Create: `src/server/score/remote-fit-coverage.ts` (+ npm script `remote-fit:coverage`)
- Verify: full-gate

**Interfaces:**
- Consumes: everything above (end-to-end).

- [ ] **Step 1: Find the E2E precedent** — locate the existing eligibility E2E journey (spec 2026-07-12 §10 "flip relocation → feed re-scopes → excluded moves") and copy its structure. Run: `git ls-files | grep -Ei 'e2e|\.spec\.ts$'` to find the dir + a template.

- [ ] **Step 2: Write the E2E journey** — seed one job with `tz_band: "americas"` (US hours) and one with `tz_band: "apac"`, profile `scheduleFlex: "any-hours"`. **Each seeded job needs a `job_scores` row** — the feed/detail queries inner-join `job_scores`, so a job with no score never appears (the eligibility E2E precedent from Step 1 shows the seed shape). Assert both visible, `excluded` = 0. Navigate `/profile`, click "Malaysia hours" (base-hours). Return to the feed: assert the US-hours job is gone, the APAC job remains, and the excluded count reads 1.

- [ ] **Step 3: Run E2E** — `npm run test:e2e` (path-filtered to the new spec) → PASS.

- [ ] **Step 4: Coverage script** — `src/server/score/remote-fit-coverage.ts`, mirroring `eligibility-distribution.ts`: load all jobs, count `tz_band` distribution (`apac|emea|americas|null`) and `hiring_structure` distribution, print percentages. Add `"remote-fit:coverage": "tsx src/server/score/remote-fit-coverage.ts"` to `package.json`. This is the §11 gate instrument — if stated-TZ coverage is near zero after a real scan, that is the evidence promoting the deep-crawl extractor (memory `project-deep-crawl-extractor-idea`).

- [ ] **Step 5: Full gate** — `npm run check` (typecheck && vitest run && contract:check && build) → PASS. Fix any drift (most likely `contract:check` needing a regenerated openapi commit).

- [ ] **Step 6: Commit**

```bash
git add e2e/ src/server/score/remote-fit-coverage.ts package.json
git commit -m "feat(remote-fit): E2E dial-flip journey + §11 coverage script"
```

---

## Self-Review (run against the spec)

**Spec coverage:** §3 contract → T1; §4 extraction/liveness → T3; §5 normalization → T4; §6 persistence/write-points + **scan-hardening rider (T5 Step 5b)** → T2+T5; §7 feed behaviour → T6+T7; §8 profile page → T8; §9 fail-loud → enforced across (permissive seed T2, stated-only T3, log-never-guess T4, live-verify gate T3); §10 testing → unit T4, repo T6, DOM T7/T8, live T3, E2E T9; §11 validation gate → T9 coverage script; §12 doc ripple → folded (T1 api-contract, T4/T6 system-architecture, T7/T8 component-inventory); §13 out-of-scope respected (no deep-crawl, no calendar dial, no overlap arithmetic, no match-score change).

**Decisions (resolved by the Fable review — see Resolved Decisions):** D1 → do NOT bump `policyVersion` (no read path; spec §4 clause is a documented erratum). D2 → schedule/structure pills ride `Job.tags` with `tone: "neutral"` + additive `title?`, rendered on `JobRow` via a `neutral`-tone filter. No open decisions block execution.

**Type consistency:** enum string sets are pinned in Global Constraints and reused verbatim in T1/T2/T4; `resolveTzBand`/`probeTzToken`/`allowedBandsFor`/`allowedStructuresFor` signatures declared in T4 and consumed unchanged in T5/T6 (`bandMinFlex` was dropped as an unused export); `updateRemoteFit` declared in T5 and consumed via columns in T6; `JdFactsEmitSchema`/`emitToFacts` declared in T3 and consumed in T5/T7; `Tone` gains `"neutral"` in T7; `onScheduleChange`/`onEmploymentChange` declared in T8.
