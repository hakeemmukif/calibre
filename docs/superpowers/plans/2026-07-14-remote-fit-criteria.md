# Remote-Fit Criteria — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new operator-profile dials — schedule tolerance (foreign-timezone overlap) and employment structure (employee/EOR vs local-entity) — become server-side feed gates matched against stated job facts, so a remote-global posting the operator can't actually take from Malaysia is hidden before it's seen; and the jd-extract LLM call is fixed to reliably emit the facts these gates depend on.

**Architecture:** Facts on the job, dials on the profile, composed at feed-read — the proven eligibility pattern (`docs/superpowers/specs/2026-07-12-remote-local-eligibility-design.md`). A pure `resolveTzBand` resolver + a stated-only `hiringStructure` fact are stamped onto two new nullable `jobs` columns at the same write points as `eligibility`; the feed predicate adds a schedule gate and a structure gate (NULL always passes); `stats.excluded` counts all three gates. The dials live on `/profile`. A required-but-nullable jd-extract *emission schema* forces gpt-oss-120b to actually emit the stated facts (the Layer-C liveness fix). Zero new LLM calls; the resolver and gates are pure and deterministic.

**Tech Stack:** Next.js 15 App Router, TypeScript, Zod (`src/types` is contract canon), Drizzle + Postgres (PGlite in tests via `createTestDb()`), vitest (colocated `*.test.ts`), Playwright e2e (doubles mode), Storybook. OpenRouter LLM via `src/lib/llm/client.ts` (`gpt-oss-120b`, `strict: false`).

**Authoritative spec:** `docs/superpowers/specs/2026-07-14-remote-fit-criteria-design.md` (status: approved). Section references below (§N) point to it.

## Global Constraints

- **Facts on the job, dials on the profile, composed at feed-read.** No per-user stamps, no LLM-judged gating, no feed re-ranking. `match-score` template and fit scoring stay orthogonal to geography/schedule/structure. (§2.7, §7.)
- **Stated-only, never a guess.** The schedule gate needs a *mapped* band; the structure gate needs a *stated* enum. Unstated → no effect. The ONE sanctioned inference is an explicit contract-term role ("12-month contract") ⇒ `hiringStructure: "contractor"` (§2.5, §4, §9.5).
- **Unstated structure shows no warn pill** — unlike geography, an unstated employment structure is a negotiable detail, not an applyability risk (§2.5). Unstated *geography* keeps its existing "Eligibility unverified" warn pill (predecessor contract, unchanged).
- **NULL always passes.** `tz_band IS NULL` or `hiring_structure IS NULL` is never hidden by its gate. The migration adds both columns as NULL with no invented backfill (§6).
- **Fail loud.** No fallback defaults. Unmapped/ambiguous TZ token (incl. bare `"CST"`) → `null` + `console.warn`, never a band (§5, §9.2). New Profile fields are required in Zod; the seed/migration provides initial values once; a missing profile row still throws `ProfileMissingError` (§9.3).
- **Permissive seed = dark by construction.** Profile migration seeds `scheduleFlex: "any-hours"`, `employmentPref: "any"` — every band/structure passes, so the feed is byte-identical before/after until a dial is touched (§6, §9.4).
- **Base country MY only at launch.** Band→dial mapping is relative to `baseCountry`, gated `baseCountry === "MY"` exactly like `REGIONS_INCLUDING_MY` (`eligibility.ts:47`). No other base country is wired (§5).
- **Job wire shape gains ZERO new fields.** Display rides `Job.tags` (schedule/structure pills pushed in `assembleJob`) and the detail gaps panel (`workCalendar`). The predicate runs server-side on the new `jobs` columns (§3).
- **Untouched, deliberately:** `Persona`/`Source.persona`/`Job.persona`, `EligibilityTier` semantics, dedupe keys, the `match-score` template, tracker entities, `PersonaToggle`, `Tone` enum. Compose the existing 14 primitives (`src/caliber-ui/components`) — no new primitive.
- **Contract changes update `docs/architecture/api-contract.md` in the same task**, then `npm run contract` regenerates `contract/openapi.json` (gated by `npm run contract:check`).
- Tests: `npx vitest run <path>` per step; task-scoped verify runs the task's named test files then `npm run typecheck`. The final task runs `npm run check` (typecheck + vitest + contract:check + build). E2E: `npm run test:e2e -- <spec>` (needs native Postgres).
- Migrations: edit `src/server/persistence/schema.ts`, run `npm run db:generate` (`DATABASE_URL` must be set), hand-adjust the generated SQL where the plan says so, `npm run db:migrate`. PGlite tests replay `drizzle/*.sql` automatically. Migration ordinals below (`0008`/`0009`) are ordinals — keep drizzle's generated slug names.
- Commits: small, per task, conventional prefixes (`feat(...)`, `test(...)`, `docs(...)`). `git add` lists explicit paths, never `-A`. **Never add a `Co-Authored-By` trailer.**
- **Reality wins:** where a snippet's prop/field name collides with the actual code, adjust the snippet's names, keep its substance, and say so in the commit body.

---

### Task 1: Contract types — dials, fact enums, Profile fields, api-contract

**Files:**
- Modify: `src/types/index.ts` (after `RelocationPref` :80-81 and `EligibilityTier` :48-52; extend `Profile` :83-91)
- Modify: `docs/architecture/api-contract.md` (§2 schema block :79-89; §3 four-axis paragraph :229)
- Regenerate: `contract/openapi.json` (via `npm run contract`)
- Test: `src/types/index.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `ScheduleFlex` (`z.enum(["base-hours","flex-evenings","any-hours"])`), `EmploymentPref` (`z.enum(["any","employee","local-entity"])`), `TzBand` (`z.enum(["apac","emea","americas"])`), `HiringStructure` (`z.enum(["local-entity","eor","contractor"])`), each with its `z.infer` type companion; `Profile` gains `scheduleFlex: ScheduleFlex` and `employmentPref: EmploymentPref` (both required).

- [ ] **Step 1: Write the failing test**

Create/extend `src/types/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EmploymentPref, HiringStructure, Profile, ScheduleFlex, TzBand } from "./index";

describe("remote-fit contract types", () => {
  it("ScheduleFlex is the ordered 3-level scale", () => {
    expect(ScheduleFlex.options).toEqual(["base-hours", "flex-evenings", "any-hours"]);
  });
  it("EmploymentPref admits any | employee | local-entity", () => {
    expect(EmploymentPref.options).toEqual(["any", "employee", "local-entity"]);
  });
  it("TzBand and HiringStructure enumerate the stated facts", () => {
    expect(TzBand.options).toEqual(["apac", "emea", "americas"]);
    expect(HiringStructure.options).toEqual(["local-entity", "eor", "contractor"]);
  });
  it("Profile requires both new dials", () => {
    const base = { baseCountry: "MY", relocation: "stay", updatedAt: "2026-07-14T00:00:00.000Z" };
    expect(() => Profile.parse(base)).toThrow(); // scheduleFlex/employmentPref missing
    expect(() =>
      Profile.parse({ ...base, scheduleFlex: "any-hours", employmentPref: "any" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types/index.test.ts`
Expected: FAIL — `ScheduleFlex`/`EmploymentPref`/`TzBand`/`HiringStructure` are not exported; `Profile.parse` accepts the base object.

- [ ] **Step 3: Add the enums and extend Profile**

In `src/types/index.ts`, immediately after `RelocationPref` (line 81), add:

```ts
// Remote-fit dials + stated-fact enums (spec 2026-07-14-remote-fit-criteria-design.md §3).
// ScheduleFlex is ORDERED (base-hours < flex-evenings < any-hours); higher includes lower.
export const ScheduleFlex = z.enum(["base-hours", "flex-evenings", "any-hours"]);
export type ScheduleFlex = z.infer<typeof ScheduleFlex>;
// employee = local entity OR EOR; local-entity = local entity only.
export const EmploymentPref = z.enum(["any", "employee", "local-entity"]);
export type EmploymentPref = z.infer<typeof EmploymentPref>;
// Job-side stated facts (jobs.tz_band, jobs.hiring_structure). NULL in the DB = nothing stated.
export const TzBand = z.enum(["apac", "emea", "americas"]);
export type TzBand = z.infer<typeof TzBand>;
export const HiringStructure = z.enum(["local-entity", "eor", "contractor"]);
export type HiringStructure = z.infer<typeof HiringStructure>;
```

Extend `Profile` (line 86-90) to:

```ts
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex, // NEW (spec 2026-07-14 §3)
  employmentPref: EmploymentPref, // NEW (spec 2026-07-14 §3)
  updatedAt: z.string().datetime(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/types/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update api-contract.md + regenerate openapi**

In `docs/architecture/api-contract.md`, extend the `Profile` schema block (:81-89) to include `scheduleFlex: ScheduleFlex` and `employmentPref: EmploymentPref`, add the `ScheduleFlex`/`EmploymentPref`/`TzBand`/`HiringStructure` enum lines near `RelocationPref` (:79), and amend the **Three axes — never conflate** paragraph (:229) to a **four-axis** guard, appending verbatim:

```
schedule/structure facts = stated constraints (jobs.tz_band via resolveTzBand, jobs.hiring_structure stated-only) matched against the profile's scheduleFlex/employmentPref dials at feed-read (spec 2026-07-14 §3). NULL facts never gate; unstated structure shows no pill.
```

Also amend the **GET /api/jobs** paragraph (:227) so `stats.excluded` reads "hidden by the geography, schedule, OR structure gate". Then:

Run: `npm run contract && npm run contract:check`
Expected: `contract/openapi.json` regenerates; check passes.

- [ ] **Step 6: Verify + commit**

Run: `npx vitest run src/types/index.test.ts && npm run typecheck`
Expected: PASS; no type errors.

```bash
git add src/types/index.ts src/types/index.test.ts docs/architecture/api-contract.md contract/openapi.json
git commit -m "feat(remote-fit): profile dials + stated-fact enums in the contract"
```

---

### Task 2: jd-extract emission schema + new stated facts + template (the Layer-C liveness fix §4)

This task fixes the live gap where gpt-oss-120b drops `.optional()` fields (`jdFacts.ts:44-52`), so the resolver's Layer C runs on parser+priors alone. It introduces ONE required-but-nullable emission schema used as the `responseSchema` for BOTH jd-extract callers, adds three new stated facts, and bumps `job_scores.policyVersion` to include the jd-extract template hash.

**Files:**
- Modify: `src/server/score/jdFacts.ts` (schemas + both wrappers :10-68)
- Modify: `config/templates/jd-extract.md` (`user:instructions` block)
- Modify: `src/lib/llm/templates.ts` (add `scoringPolicyVersion`)
- Modify: `src/server/score/index.ts:113` (use `scoringPolicyVersion()`)
- Test: `src/server/score/jdFacts.test.ts` (extend)

**Interfaces:**
- Consumes: `HiringStructure` (Task 1).
- Produces: `JdFactsSchema` gains `tzRequirement?`, `hiringStructure?`, `workCalendar?` (parse-side, optional — unchanged tolerance). `JdFactsEmissionSchema` (every field required; scalars nullable; `isJobPosting` required non-null boolean; arrays required). `extractJdFacts` and `extractJdFactsForGate` both send `JdFactsEmissionSchema` and normalize nulls→undefined via `normalizeEmission`; their public return types (`JdFacts` / `JdFactsGate`) are unchanged. `scoringPolicyVersion(): string` = 12-hex sha256 of `match-score.md` + `jd-extract.md` concatenated.

- [ ] **Step 1: Write the failing tests**

Extend `src/server/score/jdFacts.test.ts`:

```ts
import { JdFactsEmissionSchema, JdFactsSchema, normalizeEmission } from "./jdFacts";
import { scoringPolicyVersion } from "@/lib/llm/templates";

describe("jd-extract emission schema (Layer-C liveness fix, spec 2026-07-14 §4)", () => {
  it("emission schema marks every eligibility+schedule fact as REQUIRED (nullable)", () => {
    const json = z.toJSONSchema(JdFactsEmissionSchema) as { required?: string[] };
    for (const f of ["hiringScope", "hiringCountries", "location", "remotePolicy", "tzRequirement", "hiringStructure", "workCalendar"]) {
      expect(json.required).toContain(f);
    }
  });
  it("isJobPosting stays a required non-null boolean (the gate decision)", () => {
    expect(() => JdFactsEmissionSchema.parse({ ...emissionFixture(), isJobPosting: null })).toThrow();
  });
  it("normalizeEmission turns nulls into undefined for the tolerant JdFacts", () => {
    const norm = normalizeEmission({ ...emissionFixture(), tzRequirement: null, hiringStructure: null });
    expect(norm.tzRequirement).toBeUndefined();
    expect(norm.hiringStructure).toBeUndefined();
    expect(JdFactsSchema.parse(norm)).toBeTruthy();
  });
  it("parse-side JdFactsSchema accepts a stated contractor structure", () => {
    expect(JdFactsSchema.parse({ ...jdFixture(), hiringStructure: "contractor" }).hiringStructure).toBe("contractor");
  });
  it("scoringPolicyVersion changes when jd-extract.md changes (verdict cache invalidates)", () => {
    expect(scoringPolicyVersion()).toMatch(/^[0-9a-f]{12}$/);
  });
});
```

Add small `emissionFixture()`/`jdFixture()` helpers near the top of the test file returning a fully-populated emission object and a minimal valid `JdFacts` respectively (every emission scalar present, arrays present).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/score/jdFacts.test.ts`
Expected: FAIL — `JdFactsEmissionSchema`/`normalizeEmission`/`scoringPolicyVersion` not exported.

- [ ] **Step 3: Add the three stated facts to the tolerant schema**

In `src/server/score/jdFacts.ts`, inside `JdFactsSchema` (after `hiringCountries`, :24), add:

```ts
  // Spec 2026-07-14 §4: schedule + structure facts (STATED only, never guessed).
  tzRequirement: z.string().optional(), // verbatim stated overlap requirement, e.g. "4h overlap with PST"
  hiringStructure: HiringStructure.optional(), // "via Deel/EOR" | "B2B contract" | explicit contract-term role
  workCalendar: z.string().optional(), // stated calendar expectations — display only, no dial
```

Add `import { HiringStructure } from "@/types";` at the top.

- [ ] **Step 4: Add the emission schema + normalizer**

Replace the `JdFactsGateSchema` block (:53-56) with the emission schema and keep a gate alias, and add `normalizeEmission`:

```ts
// The RESPONSE schema for EVERY jd-extract LLM call (spec 2026-07-14 §4). gpt-oss-120b
// drops `.optional()` fields under `strict:false`; making each field REQUIRED (nullable
// for scalars) forces emission. isJobPosting stays required non-null — it is the gate
// decision. Arrays stay required (model emits []). Parse-side JdFacts is unchanged; nulls
// normalize away at the boundary (normalizeEmission).
export const JdFactsEmissionSchema = z.object({
  title: z.string(),
  isJobPosting: z.boolean(),
  company: z.string().nullable(),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  location: z.string().nullable(),
  remotePolicy: z.string().nullable(),
  hiringScope: z.enum(["anywhere", "restricted"]).nullable(),
  hiringCountries: z.array(z.string()),
  tzRequirement: z.string().nullable(),
  hiringStructure: HiringStructure.nullable(),
  workCalendar: z.string().nullable(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().nullable(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()),
});
export type JdFactsEmission = z.infer<typeof JdFactsEmissionSchema>;

// null → undefined, so downstream (resolveEligibility, resolveTzBand, runGate) sees the
// tolerant optional shape it already expects.
export function normalizeEmission(raw: JdFactsEmission): JdFacts {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null) out[k] = v;
  return JdFactsSchema.parse(out);
}

// Gate return type: isJobPosting non-null boolean + company nullable (unchanged contract).
export type JdFactsGate = JdFacts & { isJobPosting: boolean; company: string | null };
```

- [ ] **Step 5: Point both wrappers at the emission schema**

Rewrite `extractJdFacts` (:33-42) and `extractJdFactsForGate` (:59-68):

```ts
export async function extractJdFacts(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  const res = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmissionSchema,
  });
  return { ...res, data: normalizeEmission(res.data) };
}

export async function extractJdFactsForGate(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFactsGate; model: string; costUsd: number }> {
  const res = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmissionSchema,
  });
  // isJobPosting is a real boolean (emission-required); company stays string|null.
  const data: JdFactsGate = { ...normalizeEmission(res.data), isJobPosting: res.data.isJobPosting, company: res.data.company };
  return { ...res, data };
}
```

`runGate` (`url-check/run.ts:120-126`) is unchanged: it still reads `data.isJobPosting === false` (real boolean) and `!data.company` (undefined-or-empty → incomplete). Confirm its import of `JdFactsGate` still resolves.

- [ ] **Step 6: Edit the jd-extract template**

In `config/templates/jd-extract.md`, extend the `user:instructions` block. After the `hiringScope`/`hiringCountries` instruction, insert (keeping the existing "do not guess" contract):

```
Also extract, stated-only (leave null if the posting does not say):
- tzRequirement: any required timezone/working-hours overlap, verbatim (e.g. "4h overlap
  with PST", "EU working hours"). Timezone/overlap requirements go HERE, not in
  hiringCountries — geography and schedule are separate facts.
- hiringStructure: one of "local-entity" (hired onto the company's local entity),
  "eor" (via an EOR/PEO such as Deel/Remote/Oyster, or an explicit B2B contract), or
  "contractor". The ONLY inference allowed: an explicitly contract-term role (e.g.
  "12-month contract") means "contractor". Otherwise leave null.
- workCalendar: any stated public-holiday/working-calendar expectation, verbatim. Display
  only; leave null if unstated.
```

- [ ] **Step 7: Bump the scoring policy version to include jd-extract**

In `src/lib/llm/templates.ts`, after `policyVersion` (:79-81), add:

```ts
// The verdict-cache key version for job_scores. Hashes match-score AND jd-extract so a
// change to either template invalidates cached scores (spec 2026-07-14 §4). policyVersion(task)
// stays per-task and unaffected (jdFacts.test.ts guard holds).
export function scoringPolicyVersion(): string {
  return createHash("sha256")
    .update(readTemplateFile("match-score") + readTemplateFile("jd-extract"), "utf-8")
    .digest("hex")
    .slice(0, 12);
}
```

In `src/server/score/index.ts`, change the import to add `scoringPolicyVersion` and replace `policyVersion: policyVersion("match-score")` (:113) with `policyVersion: scoringPolicyVersion()`.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/server/score/jdFacts.test.ts src/lib/llm`
Expected: PASS. The existing `jdFacts.test.ts:110-116` guard (`policyVersion("match-score")` unaffected by jd-extract edits) stays green — `policyVersion(task)` is untouched.

- [ ] **Step 9: Verify + commit**

Run: `npx vitest run src/server/score src/server/url-check src/lib/llm && npm run typecheck`
Expected: PASS; no type errors. (If `url-check/run.ts` tests assert on old schema names, adjust the assertions, not the gate behaviour.)

```bash
git add src/server/score/jdFacts.ts src/server/score/jdFacts.test.ts src/server/score/index.ts src/lib/llm/templates.ts config/templates/jd-extract.md
git commit -m "feat(remote-fit): required-nullable jd-extract emission schema forces stated facts (Layer-C liveness fix)"
```

> **OPERATOR GATE (do before trusting the gates):** run one live 3/3 verification that gpt-oss-120b now emits `tzRequirement`/`hiringStructure`/`workCalendar`/`hiringScope`/`hiringCountries` (paste a JD with a stated TZ + EOR mention through the url-check gate three times; confirm all three responses carry the fields). Same bar as the 2026-07-13 fix. Record the result in the Task 9 report. Until verified, the feature stays dark by the permissive seed.

---

### Task 3: `resolveTzBand` + gate-resolution helpers (pure, §5)

**Files:**
- Create: `src/server/score/tzBand.ts`
- Test: `src/server/score/tzBand.test.ts`

**Interfaces:**
- Consumes: `TzBand`, `ScheduleFlex`, `EmploymentPref`, `HiringStructure` (Task 1).
- Produces: `resolveTzBand(args: { tzRequirement?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null` (tzRequirement is authority; falls back to the location string; `null` when no band maps or the token is ambiguous). `hiddenBandsFor(flex: ScheduleFlex): TzBand[]` and `hiddenStructuresFor(pref: EmploymentPref): HiringStructure[]` — the sets the feed predicate hides.

- [ ] **Step 1: Write the failing tests**

Create `src/server/score/tzBand.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { hiddenBandsFor, hiddenStructuresFor, resolveTzBand } from "./tzBand";

describe("resolveTzBand token table (spec 2026-07-14 §5)", () => {
  it.each([
    ["4h overlap with PST", "americas"],
    ["EU working hours", "emea"],
    ["APAC hours", "apac"],
    ["Remote (EST hours)", "americas"],
    ["SGT business hours", "apac"],
  ])("maps %s → %s", (tz, band) => {
    expect(resolveTzBand({ tzRequirement: tz })?.band).toBe(band);
  });
  it("bare CST is ambiguous → null + logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ tzRequirement: "CST hours" })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it("unmapped token → null + logs (curated-map drift)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ tzRequirement: "Mars Standard Time" })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it("tzRequirement wins over location", () => {
    expect(resolveTzBand({ tzRequirement: "PST overlap", location: "Remote (EU hours)" })?.band).toBe("americas");
  });
  it("nothing stated → null, no log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("gate resolution", () => {
  it("hiddenBandsFor is derived from the ordered dial", () => {
    expect(hiddenBandsFor("base-hours").sort()).toEqual(["americas", "emea"]);
    expect(hiddenBandsFor("flex-evenings")).toEqual(["americas"]);
    expect(hiddenBandsFor("any-hours")).toEqual([]);
  });
  it("hiddenStructuresFor matches the admit rules", () => {
    expect(hiddenStructuresFor("any")).toEqual([]);
    expect(hiddenStructuresFor("employee")).toEqual(["contractor"]);
    expect(hiddenStructuresFor("local-entity").sort()).toEqual(["contractor", "eor"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/score/tzBand.test.ts`
Expected: FAIL — module `./tzBand` not found.

- [ ] **Step 3: Implement the resolver + helpers**

Create `src/server/score/tzBand.ts` (mirrors `eligibility.ts`'s pure-resolver style — curated token table, `console.warn` on drift, fail-loud `null`):

```ts
// Timezone-band resolver + gate helpers (spec 2026-07-14-remote-fit-criteria-design.md §5).
// Pure. Maps a STATED overlap requirement (or a location string's TZ tokens) to a coarse
// band relative to base country MY. No band ⇒ null ⇒ never hidden by the schedule gate.
import type { EmploymentPref, HiringStructure, ScheduleFlex, TzBand } from "@/types";

// Curated token → band. Coarse by design (overlap-hour arithmetic deliberately dropped, §5).
const BAND_TOKENS: { band: TzBand; tokens: string[] }[] = [
  { band: "americas", tokens: ["PST", "PDT", "MST", "EST", "EDT", "ET", "PT", "US HOURS", "NORTH AMERICA", "LATAM"] },
  { band: "emea", tokens: ["CET", "CEST", "GMT", "BST", "UTC", "EU HOURS", "EUROPEAN", "EMEA"] },
  { band: "apac", tokens: ["SGT", "MYT", "AEST", "JST", "APAC HOURS", "APAC"] },
];
// "CST" is ambiguous (US Central vs China Standard) — never a band (§5, §9.2).
const AMBIGUOUS = ["CST"];

function bandForString(s: string): { band: TzBand; matched: string } | "ambiguous" | null {
  const up = ` ${s.toUpperCase().replace(/[^A-Z ]/g, " ")} `;
  if (AMBIGUOUS.some((t) => up.includes(` ${t} `))) return "ambiguous";
  for (const { band, tokens } of BAND_TOKENS) {
    const hit = tokens.find((t) => up.includes(` ${t} `));
    if (hit) return { band, matched: hit };
  }
  return null;
}

export function resolveTzBand(args: { tzRequirement?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null {
  const tz = args.tzRequirement?.trim();
  const loc = args.location?.trim();
  for (const [source, value] of [["JD", tz], ["location", loc]] as const) {
    if (!value) continue;
    const r = bandForString(value);
    if (r === "ambiguous") {
      console.warn(`tzBand: ambiguous timezone token in "${value}" (CST) — not banded`);
      return null;
    }
    if (r) return { band: r.band, evidence: `${source}: ${r.matched}` };
    if (source === "JD") {
      // JD stated an overlap requirement we couldn't map — curated-map drift signal (§5).
      console.warn(`tzBand: unmapped stated timezone requirement "${value}"`);
      return null;
    }
  }
  return null;
}

// Band → minimum dial that admits it, relative to base MY (§5): apac needs base-hours,
// emea needs flex-evenings, americas needs any-hours.
const RANK: Record<ScheduleFlex, number> = { "base-hours": 0, "flex-evenings": 1, "any-hours": 2 };
const BAND_MIN: Record<TzBand, ScheduleFlex> = { apac: "base-hours", emea: "flex-evenings", americas: "any-hours" };

// The bands hidden at a given tolerance = those whose minimum dial exceeds it.
export function hiddenBandsFor(flex: ScheduleFlex): TzBand[] {
  return (Object.keys(BAND_MIN) as TzBand[]).filter((b) => RANK[BAND_MIN[b]] > RANK[flex]);
}

// employee admits local-entity + eor; local-entity admits only local-entity (§7).
export function hiddenStructuresFor(pref: EmploymentPref): HiringStructure[] {
  if (pref === "employee") return ["contractor"];
  if (pref === "local-entity") return ["eor", "contractor"];
  return [];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/server/score/tzBand.test.ts`
Expected: PASS (all cases). If a token-normalization edge fails, fix the token table or matcher — never delete a case.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run src/server/score/tzBand.test.ts && npm run typecheck`

```bash
git add src/server/score/tzBand.ts src/server/score/tzBand.test.ts
git commit -m "feat(remote-fit): resolveTzBand + gate-resolution helpers (pure, curated token table)"
```

---

### Task 4: Profile dials end-to-end — table, migration, seed, repo, API, client

**Files:**
- Modify: `src/server/persistence/schema.ts` (`profile` table :85-91)
- Modify: generated `drizzle/0008_<slug>.sql` (hand-edit: backfill-then-tighten)
- Modify: `src/server/persistence/seed.ts` + `src/server/persistence/seed-test.ts` (profile seed)
- Modify: `src/server/persistence/repos/profile.ts` (`update()` input :27-35)
- Modify: `src/app/api/profile/route.ts` (`toWire` :18-24)
- Modify: `src/features/profile/client.ts` (`updateProfile` input :10-16)
- Test: `src/server/persistence/repos/profile.test.ts`, `src/app/api/profile/route.test.ts`

**Interfaces:**
- Consumes: `ScheduleFlex`, `EmploymentPref` (Task 1).
- Produces: `profileRepo.update({ baseCountry, relocation, scheduleFlex, employmentPref })`; `PUT /api/profile` accepts+returns the two dials; `updateProfile(...)` client input gains them. Seed writes `scheduleFlex: "any-hours"`, `employmentPref: "any"`.

- [ ] **Step 1: Write the failing repo + route tests**

Extend `src/server/persistence/repos/profile.test.ts`:

```ts
it("update round-trips both new dials", async () => {
  const db = await createTestDb(); // seed provides the singleton
  const repo = createProfileRepo(db);
  const row = await repo.update({ baseCountry: "MY", relocation: "open", scheduleFlex: "flex-evenings", employmentPref: "employee" });
  expect(row.scheduleFlex).toBe("flex-evenings");
  expect(row.employmentPref).toBe("employee");
});
it("seeded singleton is permissive by default (any-hours / any)", async () => {
  const db = await createTestDb();
  const row = await createProfileRepo(db).get();
  expect(row.scheduleFlex).toBe("any-hours");
  expect(row.employmentPref).toBe("any");
});
```

Extend `src/app/api/profile/route.test.ts` to PUT a body including `scheduleFlex`/`employmentPref` and assert the 200 response carries them; and that omitting them 422s.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts src/app/api/profile/route.test.ts`
Expected: FAIL — column/property `scheduleFlex` unknown.

- [ ] **Step 3: Add the columns + generate + hand-edit the migration**

In `schema.ts` `profile` (after `relocation` :88) add:

```ts
  scheduleFlex: text("schedule_flex", { enum: ["base-hours", "flex-evenings", "any-hours"] }).notNull(),
  employmentPref: text("employment_pref", { enum: ["any", "employee", "local-entity"] }).notNull(),
```

Run: `npm run db:generate` → produces `drizzle/0008_<slug>.sql` with two `ADD COLUMN ... NOT NULL` statements (which would fail on the populated singleton row). **Hand-edit** to backfill-then-tighten (mirrors predecessor migration 0005):

```sql
ALTER TABLE "profile" ADD COLUMN "schedule_flex" text DEFAULT 'any-hours' NOT NULL;
ALTER TABLE "profile" ADD COLUMN "employment_pref" text DEFAULT 'any' NOT NULL;
ALTER TABLE "profile" ALTER COLUMN "schedule_flex" DROP DEFAULT;
ALTER TABLE "profile" ALTER COLUMN "employment_pref" DROP DEFAULT;
```

(DROP DEFAULT keeps inserts fail-loud: every writer must supply values.) This backfills the existing singleton to the permissive dials — feed stays byte-identical (§6).

- [ ] **Step 4: Seed the dials in both seeds**

In `seed.ts` and `seed-test.ts`, add `scheduleFlex: "any-hours"`, `employmentPref: "any"` to the profile seed object (the permissive default, §6).

- [ ] **Step 5: Thread the dials through repo, API, client**

- `repos/profile.ts` `update()` (:27) — widen the input type and `.set(...)`:

```ts
async update(input: { baseCountry: string; relocation: "stay" | "open"; scheduleFlex: ScheduleFlex; employmentPref: EmploymentPref }): Promise<ProfileRow> {
  const [row] = await db.update(profile)
    .set({ baseCountry: input.baseCountry, relocation: input.relocation, scheduleFlex: input.scheduleFlex, employmentPref: input.employmentPref, updatedAt: sql`now()` })
    .where(eq(profile.id, SINGLETON_ID)).returning();
  if (!row) throw new ProfileMissingError();
  return row;
}
```

- `route.ts` `toWire` (:18) — add `scheduleFlex: row.scheduleFlex, employmentPref: row.employmentPref` to the parsed object. `RequestBody = Profile.omit({ updatedAt: true })` (:11) already picks up the new required fields, so PUT validation is automatic.
- `features/profile/client.ts` `updateProfile` (:10) — widen the input type to include the two dials.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/server/persistence src/app/api/profile && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Apply the migration + verify + commit**

Run: `npm run db:migrate` (needs `DATABASE_URL`). Then:

Run: `npx vitest run src/server/persistence src/app/api/profile && npm run typecheck`

```bash
git add src/server/persistence/schema.ts drizzle/0008_*.sql drizzle/meta src/server/persistence/seed.ts src/server/persistence/seed-test.ts src/server/persistence/repos/profile.ts src/server/persistence/repos/profile.test.ts src/app/api/profile/route.ts src/app/api/profile/route.test.ts src/features/profile/client.ts
git commit -m "feat(remote-fit): profile dials persist end-to-end (permissive seed = no-op)"
```

---

### Task 5: jobs fact columns + write-point stamping

**Files:**
- Modify: `src/server/persistence/schema.ts` (`jobs` :116-139)
- Modify: generated `drizzle/0009_<slug>.sql` (nullable columns, no backfill)
- Modify: `src/server/persistence/repos/jobs.ts` (`upsertByDedupeKey` row type :95; broaden the Layer-C write :209-216)
- Modify: `src/server/search/run.ts` (scan ingest stamp :333-359)
- Modify: `src/server/url-check/run.ts` (paste ingest stamp :230-255)
- Modify: `src/server/score/index.ts` (Layer-C refresh :57-66)
- Test: `src/server/persistence/repos/jobs.test.ts`, `src/server/score/index.test.ts`

**Interfaces:**
- Consumes: `resolveTzBand` (Task 3); `JdFacts.tzRequirement`/`hiringStructure` (Task 2); `TzBand`/`HiringStructure` (Task 1).
- Produces: `jobs.tz_band` (nullable enum `apac|emea|americas`) + `jobs.hiring_structure` (nullable enum `local-entity|eor|contractor`); `jobsRepo.updateResolvedGeo(id, { eligibility, eligibilityEvidence, tzBand, hiringStructure })` (replaces `updateEligibility`, one caller); `upsertByDedupeKey` row gains `tzBand`/`hiringStructure`.

- [ ] **Step 1: Write the failing tests**

In `jobs.test.ts`: insert a job, call `updateResolvedGeo` with a band + structure, assert both columns persisted; assert a NULL insert (no facts) leaves both NULL. In `index.test.ts` (scoreJob): with a mocked `extractJdFacts` returning `{ tzRequirement: "PST overlap", hiringStructure: "eor" }`, assert `jobsRepo.updateResolvedGeo` is called with `tzBand: "americas"`, `hiringStructure: "eor"`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/persistence/repos/jobs.test.ts src/server/score/index.test.ts`
Expected: FAIL — column/method missing.

- [ ] **Step 3: Add the columns + migration**

In `schema.ts` `jobs` (after `eligibilityEvidence` :136) add:

```ts
  // Spec 2026-07-14 §6: stated schedule/structure facts. NULL = nothing stated (never gated).
  tzBand: text("tz_band", { enum: ["apac", "emea", "americas"] }),
  hiringStructure: text("hiring_structure", { enum: ["local-entity", "eor", "contractor"] }),
```

Run: `npm run db:generate` → `drizzle/0009_<slug>.sql` with two plain nullable `ADD COLUMN` statements — no hand-edit needed (nullable, no backfill). Then `npm run db:migrate`.

- [ ] **Step 4: Broaden the Layer-C write method**

In `repos/jobs.ts`, replace `updateEligibility` (:209-216) with:

```ts
async updateResolvedGeo(
  id: string,
  facts: { eligibility: JobRow["eligibility"]; eligibilityEvidence: string; tzBand: JobRow["tzBand"]; hiringStructure: JobRow["hiringStructure"] },
): Promise<void> {
  const [row] = await db.update(jobs)
    .set({ eligibility: facts.eligibility, eligibilityEvidence: facts.eligibilityEvidence, tzBand: facts.tzBand, hiringStructure: facts.hiringStructure })
    .where(eq(jobs.id, id)).returning({ id: jobs.id });
  if (!row) throw new Error(`jobsRepo.updateResolvedGeo: no job with id "${id}"`);
},
```

Update the bound export (:286) accordingly.

- [ ] **Step 5: Stamp at all three write points**

- `score/index.ts` (:57-66): after `resolveEligibility`, add:

```ts
const tz = resolveTzBand({ tzRequirement: jdFactsResult.data.tzRequirement, location: job.location || undefined });
await jobsRepo.updateResolvedGeo(job.id, {
  eligibility: eligibility.tier,
  eligibilityEvidence: eligibility.evidence,
  tzBand: tz?.band ?? null,
  hiringStructure: jdFactsResult.data.hiringStructure ?? null,
});
```

Add `import { resolveTzBand } from "./tzBand";`.

- `url-check/run.ts` paste ingest (:238-255): in the `upsertByDedupeKey` call add `tzBand: resolveTzBand({ tzRequirement: facts.tzRequirement, location: canonical?.location })?.band ?? null` and `hiringStructure: facts.hiringStructure ?? null`.
- `search/run.ts` scan ingest (:340-359): scan has no JD text, so `tzBand: resolveTzBand({ location: canonical.location })?.band ?? null` and `hiringStructure: null` (no stated structure at scan time; Layer-C refresh fills it if the job is later scored).

Add `resolveTzBand` imports to both `run.ts` files. Ensure `upsertByDedupeKey`'s row type (`repos/jobs.ts:95`) includes the two new nullable fields.

- [ ] **Step 6: Scan-hardening rider — gate dial-hidden postings out of scoring slots (§6)**

Locate the existing scoring-slot gate in `src/server/search/run.ts` that excludes `abroad` postings from the top-N scoring batch under relocation `stay` (predecessor eligibility Task 6; the `SCORE_BATCH_SIZE` selection). Extend it symmetrically: also skip a posting whose location-derived `tzBand` is in `hiddenBandsFor(profile.scheduleFlex)` — persisted, unscored, exactly like `abroad` under `stay`. (`hiring_structure` is `null` at scan — no JD yet — so structure gating happens only at the Layer-C refresh, not here.) Add a `run.ts` test asserting an `americas`-band posting under a `base-hours` dial is persisted but not handed to `scoreJob`.

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/server/persistence src/server/score src/server/search src/server/url-check && npm run typecheck`
Expected: PASS. (Fixtures in `__fixtures__/helpers.ts insertJob` may need `tzBand: null, hiringStructure: null` defaults — add them.)

- [ ] **Step 8: Verify + commit**

```bash
git add src/server/persistence/schema.ts drizzle/0009_*.sql drizzle/meta src/server/persistence/repos/jobs.ts src/server/persistence/repos/jobs.test.ts src/server/search/run.ts src/server/search/run.test.ts src/server/url-check/run.ts src/server/score/index.ts src/server/score/index.test.ts src/server/persistence/__fixtures__/helpers.ts
git commit -m "feat(remote-fit): stamp tz_band + hiring_structure at ingest, Layer-C refresh, scan-slot gate"
```

---

### Task 6: Feed predicate — schedule + structure gates + three-gate excluded count (§7)

**Files:**
- Modify: `src/server/persistence/repos/jobs.ts` (`buildFilterConditions` :59-77; replace `countHiddenByEligibility` :195-204)
- Modify: `src/server/search/jobsFeed.ts` (:33-79)
- Test: `src/server/persistence/repos/jobs.test.ts`, `src/server/search/jobsFeed.test.ts`

**Interfaces:**
- Consumes: `hiddenBandsFor`/`hiddenStructuresFor` (Task 3); `jobs.tzBand`/`hiringStructure` (Task 5); profile dials (Task 4).
- Produces: `JobsQuery` gains `hiddenBands?: TzBand[]`, `hiddenStructures?: HiringStructure[]` (NULL-safe hide conditions); `jobsRepo.countHiddenByPreferences({ persona, q, isNew, hiddenTiers, hiddenBands, hiddenStructures })` = OR of the three hidden sets; `stats.excluded` counts all three gates; the items predicate applies all three.

- [ ] **Step 1: Write the failing tests**

In `jobsFeed.test.ts`: seed profile `scheduleFlex: "base-hours"`; insert an `americas`-band job and an `apac`-band job (both otherwise eligible); assert the feed hides `americas`, keeps `apac` and NULL-band jobs, and `stats.excluded` counts the hidden one. Add a structure case: `employmentPref: "employee"` hides a `contractor` job, keeps `eor`/`local-entity`/NULL. Add a `pasted` scope case: all gates exempt. Add an overlap case (a job hidden by both geo and schedule counts once in `excluded`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/search/jobsFeed.test.ts`
Expected: FAIL — gates not applied; `americas` job still shown.

- [ ] **Step 3: Add NULL-safe hide conditions to the predicate**

In `repos/jobs.ts`, extend imports with `isNull, notInArray, or` (from `drizzle-orm`). In `buildFilterConditions` (after the eligibility condition :62) add:

```ts
if (q.hiddenBands && q.hiddenBands.length > 0)
  conditions.push(or(isNull(jobs.tzBand), notInArray(jobs.tzBand, q.hiddenBands)));
if (q.hiddenStructures && q.hiddenStructures.length > 0)
  conditions.push(or(isNull(jobs.hiringStructure), notInArray(jobs.hiringStructure, q.hiddenStructures)));
```

(NULL rows pass via `isNull`; only stated-and-hidden rows are excluded. Empty set ⇒ no condition ⇒ gate off.) Widen the `JobsQuery` type with the two optional arrays.

- [ ] **Step 4: Replace the excluded count with a three-gate OR**

Replace `countHiddenByEligibility` (:195-204) with:

```ts
async countHiddenByPreferences(
  q: { persona?: Persona; q?: string; isNew?: boolean; hiddenTiers: EligibilityTier[]; hiddenBands: TzBand[]; hiddenStructures: HiringStructure[] },
): Promise<number> {
  // Scope = the SAME persona/q/isNew clauses the items predicate uses (no eligibility/bands
  // passed → those conditions are absent), so this count can't drift from the feed.
  const scope = buildFilterConditions({ persona: q.persona, q: q.q, isNew: q.isNew });
  const hidden = [];
  if (q.hiddenTiers.length) hidden.push(inArray(jobs.eligibility, q.hiddenTiers));
  if (q.hiddenBands.length) hidden.push(inArray(jobs.tzBand, q.hiddenBands));
  if (q.hiddenStructures.length) hidden.push(inArray(jobs.hiringStructure, q.hiddenStructures));
  if (hidden.length === 0) return 0;
  const where = scope.length > 0 ? and(...scope, or(...hidden)) : or(...hidden);
  const rows = await db.select({ id: jobs.id }).from(jobs).where(where);
  return rows.length;
},
```

(`inArray` on a nullable column excludes NULLs automatically — a NULL fact is never counted as hidden. `buildFilterConditions` builds the persona/q/isNew scope so it stays identical to the items predicate.)

- [ ] **Step 5: Compose the gates in jobsFeed**

In `jobsFeed.ts` (:33-56), after the existing `eligibility` line add:

```ts
const hiddenBands = isPastedScope ? [] : hiddenBandsFor(profile.scheduleFlex);
const hiddenStructures = isPastedScope ? [] : hiddenStructuresFor(profile.employmentPref);
const filterScope = { ...rest, isNew: isNewFilter, eligibility, hiddenBands, hiddenStructures };
```

Replace the excluded computation (:69-73):

```ts
const excluded = isPastedScope
  ? 0
  : await jobsRepo.countHiddenByPreferences({
      persona: rest.persona, q: rest.q, isNew: isNewFilter,
      hiddenTiers: profile.relocation === "stay" ? HIDDEN_TIERS : [],
      hiddenBands, hiddenStructures,
    });
```

Add `import { hiddenBandsFor, hiddenStructuresFor } from "@/server/score/tzBand";`. Note geography is off under `open` (hiddenTiers `[]`) but schedule/structure stay active — they're independent of relocation (§7).

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/server/search/jobsFeed.test.ts src/server/persistence/repos/jobs.test.ts && npm run typecheck`
Expected: PASS. Confirm the permissive-seed no-op test still holds (any-hours + any ⇒ empty hidden sets ⇒ identical feed).

- [ ] **Step 7: Verify + commit**

```bash
git add src/server/persistence/repos/jobs.ts src/server/persistence/repos/jobs.test.ts src/server/search/jobsFeed.ts src/server/search/jobsFeed.test.ts
git commit -m "feat(remote-fit): schedule + structure feed gates and three-gate excluded count"
```

---

### Task 7: Row pills + workCalendar + excluded strip copy (§7 display)

**Files:**
- Modify: `src/features/feed/assemble.ts` (`tags` literal :59-61; gaps assembly)
- Modify: `src/caliber-ui/compositions/Feed/SummaryStrip.tsx` (:20-23)
- Test: `src/features/feed/assemble.test.ts`, `SummaryStrip` DOM/story fixtures

**Interfaces:**
- Consumes: `jobs.tzBand`/`hiringStructure` (Task 5) via the joined row; `jdFacts.workCalendar` (Task 2) via `job_scores.jd_facts`.
- Produces: `assembleJob` appends schedule/structure pills to `Job.tags` (apac suppressed; unstated → no pill) and `workCalendar` into `Job.gaps` when stated. No wire-shape change.

> **DISPLAY DECISION (flag to operator):** `Job.tags[].tone` is the `Tone` enum (`verified|good|warn|ghost|danger`) — it has no `neutral`. These pills are informational, so this plan uses `tone: "warn"` for the schedule pill and for `contractor`/`eor` structure pills, and `tone: "good"` for a `local-entity` pill. Adjust the `PILL_TONE` table below if design wants different semantics; do not widen `Tone`.

- [ ] **Step 1: Write the failing tests**

In `assemble.test.ts`: a job with `tzBand: "americas"` yields a `{ label: "US hours" }` tag; `tzBand: "emea"` → `"EU hours"`; `tzBand: "apac"` → NO schedule tag (suppressed, business-as-usual from MY); `tzBand: null` → none. `hiringStructure: "contractor"` → `{ label: "Contractor" }`; `"eor"` → `"EOR"`; `"local-entity"` → `{ tone: "good", label: "Local entity" }`; `null` → none. A `workCalendar: "US public holidays"` in the score's jd_facts appears in `job.gaps`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/feed/assemble.test.ts`
Expected: FAIL — pills/gaps absent.

- [ ] **Step 3: Extend assembleJob**

In `assemble.ts`, add label/tone tables and build the extra pills, then extend the `tags` literal (:61):

```ts
const SCHEDULE_LABEL: Record<Exclude<TzBand, "apac">, string> = { emea: "EU hours", americas: "US hours" };
const STRUCTURE_PILL: Record<HiringStructure, { tone: Tone; label: string }> = {
  contractor: { tone: "warn", label: "Contractor" },
  eor: { tone: "warn", label: "EOR" },
  "local-entity": { tone: "good", label: "Local entity" },
};

const extraTags: { tone: Tone; label: string }[] = [];
if (job.tzBand && job.tzBand !== "apac") extraTags.push({ tone: "warn", label: SCHEDULE_LABEL[job.tzBand] });
if (job.hiringStructure) extraTags.push(STRUCTURE_PILL[job.hiringStructure]);
// ...
tags: [{ tone, label: TIER_LABEL[tier] }, ...extraTags],
```

For `workCalendar`: read it from the score row's `jd_facts` (already available where `assembleJob` reads the joined score), and when present push `{ tone: "warn", k: "Work calendar", v: workCalendar }` into the `gaps` array (matching the existing `gaps` entry shape `{ tone, k, v }`).

- [ ] **Step 4: Generalize the excluded strip copy**

In `SummaryStrip.tsx` (:22), change the label to reflect all three gates:

```ts
{ label: "Outside your remote preferences · hidden", value: stats.excluded },
```

- [ ] **Step 5: Run to verify pass + update stories**

Run: `npx vitest run src/features/feed/assemble.test.ts src/caliber-ui/compositions/Feed && npm run typecheck`
Expected: PASS. Update any `SummaryStrip.stories.tsx`/DOM fixtures referencing the old label.

- [ ] **Step 6: Verify + commit**

```bash
git add src/features/feed/assemble.ts src/features/feed/assemble.test.ts src/caliber-ui/compositions/Feed/SummaryStrip.tsx
git commit -m "feat(remote-fit): schedule/structure row pills + workCalendar gap + excluded strip copy"
```

---

### Task 8: Profile page — preset row + schedule & employment segmented controls (§8)

**Files:**
- Modify: `src/caliber-ui/compositions/Profile/ProfileTargets.tsx` (:8-56)
- Modify: `src/app/profile/page.tsx` (:31-76)
- Test: `src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx`; `ProfileTargets.stories.tsx`

**Interfaces:**
- Consumes: `ScheduleFlex`/`EmploymentPref` (Task 1); `updateProfile` (Task 4).
- Produces: `ProfileTargetsProps` gains `onScheduleChange`/`onEmploymentChange`/`onPresetSelect`; four preset cards set all dials at once; two segmented controls (mirroring the relocation `Chip variant="filter"` pattern). The page's save-on-change sends the full `{ baseCountry, relocation, scheduleFlex, employmentPref }` payload.

- [ ] **Step 1: Write the failing DOM test**

`ProfileTargets.dom.test.tsx` (`// @vitest-environment jsdom`, `afterEach(cleanup)`): the schedule control renders three options captioned "Malaysia hours" / "Evenings OK — Europe overlap" / "Any hours — US overlap"; clicking one calls `onScheduleChange` with the right `ScheduleFlex`; the employment control renders "Any arrangement" / "Employee — EOR OK" / "Malaysian entity only" → `onEmploymentChange`; clicking the "Global remote" preset calls `onPresetSelect` with `{ relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" }`; `busy` disables all controls.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/caliber-ui/compositions/Profile`
Expected: FAIL — new props/controls absent.

- [ ] **Step 3: Implement the controls**

Extend `ProfileTargets.tsx`: add the three preset cards row ("Which sounds like you?") and two segmented pills built exactly like the existing relocation pill (`inline-flex` on `var(--surface-sunken)`, `Chip variant="filter"`). Preset → dial bundles (§8):

```ts
const PRESETS = [
  { key: "my-remote", label: "Malaysia-only remote", dials: { relocation: "stay", scheduleFlex: "base-hours", employmentPref: "local-entity" } },
  { key: "global", label: "Global remote", dials: { relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" } },
  { key: "nomad", label: "Digital nomad", dials: { relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" } },
  { key: "relocate", label: "Open to relocate", dials: { relocation: "open", scheduleFlex: "flex-evenings", employmentPref: "any" } },
] as const;
const SCHEDULE_OPTIONS = [
  { value: "base-hours", label: "Malaysia hours" },
  { value: "flex-evenings", label: "Evenings OK — Europe overlap" },
  { value: "any-hours", label: "Any hours — US overlap" },
] as const;
const EMPLOYMENT_OPTIONS = [
  { value: "any", label: "Any arrangement" },
  { value: "employee", label: "Employee — EOR OK" },
  { value: "local-entity", label: "Malaysian entity only" },
] as const;
```

Presets set the dials but are not stored state (dials remain the only truth, §2.3, §8).

- [ ] **Step 4: Wire the page save-on-change**

In `page.tsx`, generalize the handler (or add `handleScheduleChange`/`handleEmploymentChange`/`handlePreset`) so each sends the full profile via `updateProfile({ baseCountry, relocation, scheduleFlex, employmentPref })`, following the existing `handleRelocationChange` busy/error pattern (:31-42).

- [ ] **Step 5: Run to verify pass + story**

Run: `npx vitest run src/caliber-ui/compositions/Profile && npm run typecheck`
Expected: PASS. Add the segmented controls + presets to `ProfileTargets.stories.tsx`.

- [ ] **Step 6: Verify + commit**

```bash
git add src/caliber-ui/compositions/Profile/ProfileTargets.tsx src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx src/caliber-ui/compositions/Profile/ProfileTargets.stories.tsx src/app/profile/page.tsx
git commit -m "feat(remote-fit): /profile preset row + schedule & employment dials"
```

---

### Task 9: Recompute extension + coverage report (§6 write-points, §11 validation gate)

**Files:**
- Modify: `src/server/score/recompute-eligibility.ts` (re-derive tz_band/hiring_structure)
- Modify: `src/server/score/eligibility-distribution.ts` (or add `remote-fit-coverage.ts`) + `package.json` script
- Test: `src/server/score/recompute-eligibility.test.ts`

**Interfaces:**
- Consumes: `resolveTzBand` (Task 3); stored `job_scores.jd_facts` (unchanged).
- Produces: `recomputeEligibility()` also updates `jobs.tz_band`/`hiring_structure` from the latest `jd_facts` (zero LLM cost), including migrating old rows whose TZ terms landed in `hiringCountries`; a coverage report prints stated-band/structure counts for the §11 go/no-go gate.

- [ ] **Step 1: Write the failing test**

In `recompute-eligibility.test.ts`: a job whose latest `jd_facts` has `tzRequirement: "EU hours"` and `hiringStructure: "contractor"` but NULL columns → after `recomputeEligibility()`, `jobs.tz_band === "emea"` and `jobs.hiring_structure === "contractor"`; a job whose old `jd_facts.hiringCountries` contains `"4h overlap with PST"` (pre-fix TZ-in-geography) → `tz_band === "americas"` (migration path); `{ changed }` counts them.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/score/recompute-eligibility.test.ts`
Expected: FAIL — recompute doesn't touch tz_band/hiring_structure.

- [ ] **Step 3: Extend the recompute**

In `recompute-eligibility.ts`, inside the per-job loop, after resolving eligibility, resolve the facts and include them in the change-detection + update:

```ts
const tz = resolveTzBand({
  tzRequirement: jdFacts?.tzRequirement ?? jdFacts?.hiringCountries?.find((c) => resolveTzBand({ tzRequirement: c })), // migrate old TZ-in-geography rows
  location: job.location || undefined,
});
const tzBand = tz?.band ?? null;
const hiringStructure = jdFacts?.hiringStructure ?? null;
if (tier !== job.eligibility || evidence !== job.eligibilityEvidence || tzBand !== job.tzBand || hiringStructure !== job.hiringStructure) {
  await db.update(jobs).set({ eligibility: tier, eligibilityEvidence: evidence, tzBand, hiringStructure }).where(eq(jobs.id, job.id));
  changed += 1;
}
```

Add `import { resolveTzBand } from "./tzBand";`.

- [ ] **Step 4: Coverage report**

Extend `eligibility-distribution.ts` (or add a sibling) to also `GROUP BY tz_band` and `hiring_structure` and print stated-vs-null counts. Wire `npm run remote-fit:coverage` in `package.json` (mirror `eligibility:report`).

- [ ] **Step 5: Run to verify pass + commit**

Run: `npx vitest run src/server/score/recompute-eligibility.test.ts && npm run typecheck`

```bash
git add src/server/score/recompute-eligibility.ts src/server/score/recompute-eligibility.test.ts src/server/score/eligibility-distribution.ts package.json
git commit -m "feat(remote-fit): recompute re-derives tz_band/hiring_structure + coverage report"
```

---

### Task 10: E2E journey + docs ripple + final gate (§10, §12)

**Files:**
- Create: `e2e/remote-fit.spec.ts`
- Modify: `docs/architecture/system-architecture.md`, `docs/architecture/component-inventory.md`
- Verify: `npm run check`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the E2E journey**

`e2e/remote-fit.spec.ts` (doubles mode, mirrors `e2e/profile.spec.ts` if present): seed a `tz_band: "americas"` (US-hours) job that is otherwise eligible; load `/feed` (default permissive dials) and assert the job is visible; go to `/profile`, set the schedule dial to "Malaysia hours" (`base-hours`); return to `/feed` and assert the US-hours job is gone and the excluded count incremented — no rescan.

- [ ] **Step 2: Run the E2E**

Run: `npm run test:e2e -- remote-fit.spec.ts` (needs native Postgres, free port)
Expected: PASS.

- [ ] **Step 3: Docs ripple**

- `system-architecture.md`: add the two `jobs` columns, `resolveTzBand`, the three-gate predicate, and the emission-schema note.
- `component-inventory.md`: ProfileTargets preset row + the two new controls.

- [ ] **Step 4: Final gate**

Run: `npm run check`
Expected: PASS (typecheck + vitest + contract:check + build).

- [ ] **Step 5: Commit**

```bash
git add e2e/remote-fit.spec.ts docs/architecture/system-architecture.md docs/architecture/component-inventory.md
git commit -m "test(remote-fit): e2e schedule-dial re-scopes feed + docs ripple"
```

---

## Explicitly deferred (do NOT build in this plan)

Deep-crawl / following apply links past the first page (§2.9, §13 — its own future design; the fact schema here is exactly what it would feed). Calendar dial (§2.4 — extract + display only). Overlap-hour arithmetic (§5 — bands are coarse). Feed re-ranking, visa-sponsorship detection, multi-user auth / onboarding wizard, new connectors, any `match-score` template change (§13). Multi-tenancy `userId` — a separate track; `Profile` stays a singleton here.

## Plan-wide notes for implementers

1. **Three flagged reconciliations (spec intent vs. code reality), all resolved in-plan — re-confirm with the operator if you disagree:**
   - **One emission schema for both callers, `isJobPosting` stays a non-null boolean** (Task 2). The spec says "every field required-but-nullable following the JdFactsGateSchema precedent"; but the gate branches on `isJobPosting === false`, so it must stay a decisive boolean. All other scalars are required-nullable; arrays required.
   - **`scoringPolicyVersion()` hashes match-score + jd-extract** (Task 2). The spec says "policyVersion bumps" on the schema change, but `job_scores.policyVersion` currently hashes `match-score.md` only, which a jd-extract edit would not touch. The new helper makes the verdict cache invalidate correctly; `policyVersion(task)` stays per-task (existing test holds).
   - **Pill tone** (Task 7). `Job.tags[].tone` is `Tone` (no `neutral`); informational pills use `warn`/`good` per the `PILL_TONE` table. A design call — adjust the table, don't widen `Tone`.
2. **NULL always passes** is enforced two ways: the items predicate uses `or(isNull(col), notInArray(col, hidden))`; the excluded count uses `inArray(col, hidden)` (SQL `IN` never matches NULL). Keep both — do not "simplify" to a single `notInArray`, which would drop NULL rows.
3. **Permissive seed = no-op proof.** After Tasks 4–6, a fresh DB with the seeded `any-hours`/`any` dials must produce a byte-identical feed to pre-change. That test is the guard that the feature is dark until a dial is touched (§9.4). Never weaken it.
4. **Live-verify before trusting the gates** (operator gate after Task 2). Until the 3/3 emission verification passes on real `gpt-oss-120b`, the gates are decorative on real data — the permissive seed means no harm meanwhile. The §11 coverage report (Task 9) is the go/no-go that either validates the gates or promotes the deferred deep-crawl extractor.
5. New modules cite the spec in a header comment and mirror an existing sibling (`resolveTzBand` ↔ `resolveEligibility`; the segmented controls ↔ the relocation pill / `PersonaToggle`). Fail loud everywhere; never default a missing value.
