# Remote / Malaysia-local Eligibility Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every job gets a persisted 5-tier eligibility classification relative to the operator's profile (base country MY + relocation preference); the feed pre-filters on it, ineligible postings stop consuming LLM scoring slots, and the preference lives on a new `/profile` page.

**Architecture:** Classify-and-store with a deterministic resolver (approved spec: `docs/superpowers/specs/2026-07-12-remote-local-eligibility-design.md`, commit 96cfc28). Facts come free (source `config` annotations, a curated location-string parser, two new fields on the existing `jd-extract` LLM call); a pure resolver combines them into `jobs.eligibility` + `jobs.eligibility_evidence`. The relocation preference is a server-side feed predicate — flipping it re-scopes instantly, no rescan. Zero new LLM calls.

**Tech Stack:** Next.js 15 App Router, TypeScript, Zod (`src/types` is contract canon), Drizzle + Postgres (PGlite in tests via `createTestDb()`), vitest (colocated `*.test.ts`), Playwright e2e (doubles mode), Storybook.

## Global Constraints

- **Persona untouched.** `Persona`/`Source.persona`/`jobs.persona`/`listEnabledByPersona`/`PersonaToggle` keep exactly their current meaning (scan routing + run provenance). Never write eligibility into persona.
- **Dedupe untouched.** `secondaryKey` keeps using the raw location string (`src/server/search/dedupe.ts:590`).
- **`match-score` template untouched.** Fit stays orthogonal to geography.
- **Zero new LLM calls.** Eligibility extraction rides the existing `jd-extract` call only.
- **Fail loud.** No fallback defaults; undeterminable → tier `"unknown"` with an evidence string, never a silent eligible/hidden. Missing profile row throws `ProfileMissingError`. Enabled real-mode source missing its geo annotation throws `SourceGeoConfigError`.
- **The resolver's only sanctioned eligibility grant from a prior:** an operator-confirmed `scope: "anywhere"` source reading a bare "Remote" as `anywhere`. Heuristics and `restricted` priors never grant `anywhere`; `restricted + regions` may grant `eligible` for a bare "Remote" (Airwallex case).
- **Operator decisions (locked, spec §2):** unknowns shown with warn pill; `open` reveals ALL located-elsewhere jobs (one `abroad` tier); APAC/SEA/ASEAN/Asia → eligible from MY, foreign-TZ-overlap → unknown; chip "Remote" → "Work anywhere"; no feed re-ranking.
- **Contract changes update `docs/architecture/api-contract.md` in the same task**, and `npm run contract` regenerates `contract/openapi.json` (gated by `npm run contract:check`).
- UI composes the existing 13 primitives (`src/caliber-ui/components`), inline style objects with `var(--...)` tokens. Compositions get colocated `.stories.tsx` (+ `.dom.test.tsx` with `// @vitest-environment jsdom` pragma and explicit `afterEach(cleanup)`).
- Tests: `npm test` (vitest). Full gate before finishing a task: the task's named test files, then `npm run typecheck`. Final task runs `npm run check`.
- Migrations: edit `src/server/persistence/schema.ts`, run `npm run db:generate` (DATABASE_URL must be set, as for migrations 0000–0003), then hand-adjust the generated SQL where the plan says so. PGlite tests replay `drizzle/*.sql` automatically (`test-db.ts`).
- Commits: small, per task, conventional prefixes (`feat(...)`, `test(...)`, `docs(...)`). Never add `Co-Authored-By`.

---

### Task 1: Profile entity end-to-end (contract → table → repo → API → client)

**Files:**
- Modify: `src/types/index.ts` (add `RelocationPref`, `Profile` after the `Source` block, ~line 41)
- Modify: `src/server/persistence/schema.ts` (add `profile` table after `sources`, ~line 73)
- Create: `drizzle/0004_*.sql` (generated)
- Modify: `src/server/persistence/seed.ts`, `src/server/persistence/seed-test.ts` (seed the singleton row)
- Create: `src/server/persistence/repos/profile.ts`
- Test: `src/server/persistence/repos/profile.test.ts`
- Create: `src/app/api/profile/route.ts`
- Test: `src/app/api/profile/route.test.ts`
- Create: `src/features/profile/client.ts`
- Modify: `src/contract/registry.ts` (entity + paths), `docs/architecture/api-contract.md`
- Regenerate: `contract/openapi.json` (`npm run contract`)

**Interfaces:**
- Consumes: existing repo/route/client conventions (`sources.ts`, `api/sources/[id]/route.ts`, `features/sources/client.ts`).
- Produces (later tasks rely on these exact names):
  - `RelocationPref = z.enum(["stay", "open"])`, `Profile` zod object `{ baseCountry: string(2), relocation, updatedAt: datetime }` in `@/types`.
  - `profileRepo.get(): Promise<ProfileRow>` — **throws `ProfileMissingError`** when the singleton row is absent.
  - `profileRepo.update(input: { baseCountry: string; relocation: "stay" | "open" }): Promise<ProfileRow>` — throws `ProfileMissingError` if absent.
  - `ProfileRow = typeof profile.$inferSelect` (has `baseCountry`, `relocation`, `updatedAt: Date`).
  - Client: `getProfile(): Promise<Profile>`, `updateProfile(input: { baseCountry: string; relocation: RelocationPref }): Promise<Profile>`.

- [ ] **Step 1: Contract types**

In `src/types/index.ts`, after the `Source` export (line 41), add:

```ts
export const RelocationPref = z.enum(["stay", "open"]);
export type RelocationPref = z.infer<typeof RelocationPref>;

// Operator profile — singleton (single-operator MVP). `baseCountry` is
// ISO-3166-1 alpha-2 ("MY" at launch). The seed row IS the install step
// (seed.ts precedent); a missing row is an error, never defaulted.
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  updatedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof Profile>;
```

- [ ] **Step 2: Schema + migration**

In `src/server/persistence/schema.ts`, after the `sources` table (line 73), add:

```ts
// Operator profile — singleton row, id is the constant "default". Seeded by
// seed.ts (the seed is the install step); repos/profile.ts throws
// ProfileMissingError when absent — no runtime default.
export const profile = pgTable("profile", {
  id: text("id").primaryKey(),
  baseCountry: text("base_country").notNull(),
  relocation: text("relocation", { enum: ["stay", "open"] }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

Run: `npm run db:generate` → creates `drizzle/0004_<name>.sql` containing `CREATE TABLE "profile" (...)`. No hand-edit needed (new table, no backfill).

- [ ] **Step 3: Seed the singleton in both seeds**

In `src/server/persistence/seed.ts` — add to imports `profile` from `./schema`, then after `seedSources`:

```ts
export const profileSeed: typeof profile.$inferInsert = {
  id: "default",
  baseCountry: "MY",
  relocation: "stay",
};

export async function seedProfile(db: Db) {
  return db.insert(profile).values(profileSeed).onConflictDoNothing().returning();
}
```

and in the self-exec block, chain it (replace the existing `seedSources(getDb()).then(...)` body):

```ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  seedSources(db)
    .then(async (rows) => {
      const prof = await seedProfile(db);
      console.log(`Seeded ${rows.length} source(s), ${prof.length} profile row(s)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

Mirror the same `seedProfile` call in `src/server/persistence/seed-test.ts` (import `profile`, export the same `profileSeed`-shaped insert via a `seedTestProfile(db)` that inserts `{ id: "default", baseCountry: "MY", relocation: "stay" }`, chain it in the self-exec block). E2E (`e2e/runGlobalSetup.ts`) runs these scripts, so the scratch DB gets the row automatically.

- [ ] **Step 4: Failing repo test**

Create `src/server/persistence/repos/profile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { profile } from "../schema";
import { createProfileRepo, ProfileMissingError } from "./profile";

describe("profileRepo", () => {
  it("get() throws ProfileMissingError when the singleton row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.get()).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("get() returns the seeded row", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const repo = createProfileRepo(db);
    const row = await repo.get();
    expect(row.baseCountry).toBe("MY");
    expect(row.relocation).toBe("stay");
  });

  it("update() flips relocation and bumps updatedAt", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const repo = createProfileRepo(db);
    const before = await repo.get();
    const updated = await repo.update({ baseCountry: "MY", relocation: "open" });
    expect(updated.relocation).toBe("open");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("update() throws ProfileMissingError when the row is absent", async () => {
    const db = await createTestDb();
    const repo = createProfileRepo(db);
    await expect(repo.update({ baseCountry: "MY", relocation: "open" })).rejects.toBeInstanceOf(ProfileMissingError);
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts`
Expected: FAIL — `Cannot find module './profile'`.

- [ ] **Step 6: Implement the repo**

Create `src/server/persistence/repos/profile.ts` (mirrors the `sources.ts` factory + singleton pattern):

```ts
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
```

- [ ] **Step 7: Run repo tests**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Failing route test**

Create `src/app/api/profile/route.test.ts` (route-test conventions from `api/sources/route.test.ts`):

```ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { profile } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Profile } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET, PUT } = await import("./route");

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/profile", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(profile);
  });

  it("GET 404s with NOT_FOUND when unseeded (Resume absence pattern)", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET returns the seeded row as a valid Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => Profile.parse(body)).not.toThrow();
    expect(body.relocation).toBe("stay");
  });

  it("PUT full-replaces and returns the updated Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await PUT(putRequest({ baseCountry: "MY", relocation: "open" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Profile.parse(body).relocation).toBe("open");
  });

  it("PUT 422s on an invalid body", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await PUT(putRequest({ baseCountry: "Malaysia", relocation: "maybe" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT 404s when the row is missing", async () => {
    const res = await PUT(putRequest({ baseCountry: "MY", relocation: "open" }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 9: Run to verify failure**

Run: `npx vitest run src/app/api/profile/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 10: Implement the route**

Create `src/app/api/profile/route.ts`:

```ts
// GET/PUT /api/profile — the operator profile singleton (spec
// 2026-07-12-remote-local-eligibility-design.md §3/§7). GET 404s when the
// seed row is absent (Resume absence-is-404 pattern); PUT is a full 2-field
// replace. All DB access via profileRepo; wire shape is the frozen Profile.
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { profileRepo, ProfileMissingError, type ProfileRow } from "@/server/persistence/repos/profile";
import type { ErrorEnvelope } from "@/types";
import { Profile } from "@/types";

const RequestBody = Profile.omit({ updatedAt: true });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

function toWire(row: ProfileRow): Profile {
  return Profile.parse({
    baseCountry: row.baseCountry,
    relocation: row.relocation,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function GET() {
  try {
    return NextResponse.json(toWire(await profileRepo.get()), { status: 200 });
  } catch (err) {
    if (err instanceof ProfileMissingError) return errorResponse(404, "NOT_FOUND", err.message);
    throw err;
  }
}

export async function PUT(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  try {
    const body = RequestBody.parse(json);
    const row = await profileRepo.update(body);
    return NextResponse.json(toWire(row), { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid profile.", err.issues);
    if (err instanceof ProfileMissingError) return errorResponse(404, "NOT_FOUND", err.message);
    throw err;
  }
}
```

- [ ] **Step 11: Run route tests**

Run: `npx vitest run src/app/api/profile/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 12: Typed client**

Create `src/features/profile/client.ts` (mirrors `features/sources/client.ts`):

```ts
// Profile typed client — the /profile page (api-contract.md "GET/PUT
// /api/profile"). Never imports server/*; Profile.parse at the boundary.
import { Profile, type RelocationPref } from "@/types";
import { requestJson } from "@/features/http";

export async function getProfile(): Promise<Profile> {
  return requestJson("/api/profile", undefined, Profile);
}

export async function updateProfile(input: { baseCountry: string; relocation: RelocationPref }): Promise<Profile> {
  return requestJson(
    "/api/profile",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    Profile,
  );
}
```

- [ ] **Step 13: Contract registry + docs**

In `src/contract/registry.ts`: add `RelocationPref, Profile` to the `@/types` import and to `entitySchemas` (lines 26–68). After the `/api/health` block, register:

```ts
registry.registerPath({
  method: "get",
  path: "/api/profile",
  summary: "Operator profile — base country + relocation preference",
  responses: {
    200: { description: "The singleton profile", content: { "application/json": { schema: Profile } } },
    404: { description: "Profile row missing (unseeded install)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/profile",
  summary: "Full-replace the operator profile",
  request: { body: { content: { "application/json": { schema: Profile.omit({ updatedAt: true }) } } } },
  responses: {
    200: { description: "The updated profile", content: { "application/json": { schema: Profile } } },
    404: { description: "Profile row missing", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});
```

In `docs/architecture/api-contract.md`: add the `Profile` entity to §2 (copy the zod block from Step 1) and a §3 entry for `GET/PUT /api/profile` describing the 404-when-unseeded and full-replace semantics.

Run: `npm run contract` (regenerates `contract/openapi.json`), then `npm run contract:check`.
Expected: check passes (clean diff after regeneration is committed).

- [ ] **Step 14: Full verify + commit**

Run: `npx vitest run src/server/persistence src/app/api/profile && npm run typecheck`
Expected: PASS.

```bash
git add src/types/index.ts src/server/persistence src/app/api/profile src/features/profile src/contract/registry.ts contract/openapi.json drizzle docs/architecture/api-contract.md
git commit -m "feat(profile): operator profile singleton — contract, table, repo, API, client"
```

---

### Task 2: Eligibility contract types + the location-geo parser

**Files:**
- Modify: `src/types/index.ts` (add `EligibilityTier`, `Eligibility` after `Legitimacy`, ~line 22)
- Create: `src/server/search/geo.ts`
- Test: `src/server/search/geo.test.ts`
- Modify: `src/contract/registry.ts` (add both to `entitySchemas`), `docs/architecture/api-contract.md` (§2 entity)

**Interfaces:**
- Produces:
  - `EligibilityTier = z.enum(["anywhere", "eligible", "local", "abroad", "unknown"])`, `Eligibility = z.object({ tier, tone: Tone, summary: z.string() })` in `@/types`. (**Not** on `Job` yet — that flip is Task 8.)
  - `ParsedGeo = { countryCode?: string; workMode?: "remote" | "hybrid" | "onsite"; regionHint?: string }`.
  - `parseLocationGeo(location: string | undefined): ParsedGeo` — pure, curated tables, `{}` when nothing matches (absent ≠ fabricated).

- [ ] **Step 1: Contract types**

In `src/types/index.ts`, after the `Legitimacy` block (line 22), add:

```ts
// Eligibility — posting geography relative to the operator profile (spec
// 2026-07-12-remote-local-eligibility-design.md §3). Third axis, distinct
// from Source.persona (scan routing) and Job.persona (run provenance).
export const EligibilityTier = z.enum(["anywhere", "eligible", "local", "abroad", "unknown"]);
export type EligibilityTier = z.infer<typeof EligibilityTier>;

export const Eligibility = z.object({
  tier: EligibilityTier,
  tone: Tone,
  summary: z.string(), // the resolver's evidence string
});
export type Eligibility = z.infer<typeof Eligibility>;
```

Add `EligibilityTier, Eligibility` to `src/contract/registry.ts` imports + `entitySchemas`, and to `docs/architecture/api-contract.md` §2. Run `npm run contract`.

- [ ] **Step 2: Failing parser test**

Create `src/server/search/geo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLocationGeo } from "./geo";

describe("parseLocationGeo", () => {
  const table: [string | undefined, ReturnType<typeof parseLocationGeo>][] = [
    [undefined, {}],
    ["", {}],
    ["Remote", { workMode: "remote" }],
    ["Remote - US", { workMode: "remote", countryCode: "US" }],
    ["Remote — APAC", { workMode: "remote", regionHint: "APAC" }],
    ["Remote - Anywhere", { workMode: "remote", regionHint: "worldwide" }],
    ["Worldwide", { regionHint: "worldwide" }],
    ["Kuala Lumpur", { countryCode: "MY" }],
    ["Kuala Lumpur, Malaysia", { countryCode: "MY" }],
    ["Selangor", { countryCode: "MY" }],
    ["Petaling Jaya / Kuala Lumpur", { countryCode: "MY" }],
    ["Singapore", { countryCode: "SG" }],
    ["San Francisco / Remote", { workMode: "remote", countryCode: "US" }],
    ["New York, NY", { countryCode: "US" }],
    ["London, United Kingdom", { countryCode: "GB" }],
    ["Hybrid - Kuala Lumpur", { workMode: "hybrid", countryCode: "MY" }],
    ["Onsite, Berlin, Germany", { workMode: "onsite", countryCode: "DE" }],
    ["Remote - Southeast Asia", { workMode: "remote", regionHint: "SEA" }],
    ["Europe (Remote)", { workMode: "remote", regionHint: "EMEA" }],
    ["Klang Valley", { countryCode: "MY" }],
    ["Some Unrecognized Town", {}],
  ];

  it.each(table)("%j -> %j", (input, expected) => {
    expect(parseLocationGeo(input)).toEqual(expected);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/server/search/geo.test.ts`
Expected: FAIL — `Cannot find module './geo'`.

- [ ] **Step 4: Implement the parser**

Create `src/server/search/geo.ts`:

```ts
// Deterministic geo parsing over connector location strings (spec §5 Layer
// B). Curated token tables — a miss returns {} (absent, never fabricated).
// This layer may only DEMOTE downstream (unknown), never grant eligibility;
// grants happen in src/server/score/eligibility.ts under its precedence.

export interface ParsedGeo {
  countryCode?: string; // ISO-3166-1 alpha-2, only when derivable
  workMode?: "remote" | "hybrid" | "onsite";
  regionHint?: string; // normalized region token: APAC | SEA | EMEA | AMERICAS | ANZ | worldwide
}

// Token -> ISO country. MY gets a city/state list (the launch base country);
// other countries: names + a few unambiguous majors. Extend via tests only.
const COUNTRY_TOKENS: Record<string, string> = {
  malaysia: "MY",
  "kuala lumpur": "MY",
  selangor: "MY",
  penang: "MY",
  "johor bahru": "MY",
  cyberjaya: "MY",
  putrajaya: "MY",
  "petaling jaya": "MY",
  "klang valley": "MY",
  singapore: "SG",
  "united states": "US",
  usa: "US",
  "u.s.": "US",
  "san francisco": "US",
  "new york": "US",
  seattle: "US",
  austin: "US",
  "united kingdom": "GB",
  london: "GB",
  germany: "DE",
  berlin: "DE",
  france: "FR",
  paris: "FR",
  netherlands: "NL",
  amsterdam: "NL",
  canada: "CA",
  toronto: "CA",
  australia: "AU",
  sydney: "AU",
  india: "IN",
  bangalore: "IN",
  philippines: "PH",
  manila: "PH",
  indonesia: "ID",
  jakarta: "ID",
  vietnam: "VN",
  thailand: "TH",
  bangkok: "TH",
  japan: "JP",
  tokyo: "JP",
  "hong kong": "HK",
  taiwan: "TW",
  "south korea": "KR",
  brazil: "BR",
  mexico: "MX",
  poland: "PL",
  spain: "ES",
  portugal: "PT",
  ireland: "IE",
  dublin: "IE",
};

// US state abbreviations (postal codes) — matched as standalone tokens.
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

const REGION_TOKENS: Record<string, string> = {
  apac: "APAC",
  "asia pacific": "APAC",
  "asia-pacific": "APAC",
  asia: "APAC",
  sea: "SEA",
  "southeast asia": "SEA",
  "south east asia": "SEA",
  asean: "SEA",
  emea: "EMEA",
  europe: "EMEA",
  eu: "EMEA",
  americas: "AMERICAS",
  "north america": "AMERICAS",
  latam: "AMERICAS",
  anz: "ANZ",
  oceania: "ANZ",
  anywhere: "worldwide",
  worldwide: "worldwide",
  global: "worldwide",
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[–—]/g, "-");
}

export function parseLocationGeo(location: string | undefined): ParsedGeo {
  if (!location || location.trim().length === 0) return {};
  const norm = normalize(location);
  const geo: ParsedGeo = {};

  if (/\bremote\b/.test(norm)) geo.workMode = "remote";
  else if (/\bhybrid\b/.test(norm)) geo.workMode = "hybrid";
  else if (/\bon-?site\b/.test(norm)) geo.workMode = "onsite";

  // Multi-word tokens first (longest match wins), then single words.
  const countryEntries = Object.entries(COUNTRY_TOKENS).sort((a, b) => b[0].length - a[0].length);
  for (const [token, code] of countryEntries) {
    if (norm.includes(token)) {
      geo.countryCode = code;
      break;
    }
  }
  if (!geo.countryCode) {
    // Standalone US state abbreviation ("New York, NY" already matched above;
    // this catches "Austin, TX"-style strings whose city we don't list).
    const rawTokens = location.split(/[^A-Za-z.]+/).filter(Boolean);
    if (rawTokens.some((t) => US_STATES.has(t))) geo.countryCode = "US";
  }

  const regionEntries = Object.entries(REGION_TOKENS).sort((a, b) => b[0].length - a[0].length);
  for (const [token, hint] of regionEntries) {
    // Word-boundary match so "sea" never fires inside "Research" etc.
    if (new RegExp(`\\b${token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(norm)) {
      geo.regionHint = hint;
      break;
    }
  }

  return geo;
}
```

- [ ] **Step 5: Run parser tests**

Run: `npx vitest run src/server/search/geo.test.ts`
Expected: PASS. If a table case fails on token-order subtleties, fix the TABLE DATA or matcher — never delete a test case.

- [ ] **Step 6: Verify + commit**

Run: `npx vitest run src/server/search/geo.test.ts && npm run typecheck && npm run contract && npm run contract:check`

```bash
git add src/types/index.ts src/server/search/geo.ts src/server/search/geo.test.ts src/contract/registry.ts contract/openapi.json docs/architecture/api-contract.md
git commit -m "feat(eligibility): EligibilityTier/Eligibility contract types + deterministic location-geo parser"
```

---

### Task 3: Source geo annotations + `parseSourceGeo` + registry validation

**Files:**
- Modify: `src/server/search/geo.ts` (add `SourceGeo`, `parseSourceGeo`, `SourceGeoConfigError`)
- Test: `src/server/search/geo.test.ts` (extend)
- Modify: `src/server/persistence/seed.ts` (annotate all 13 rows), `src/server/persistence/seed-test.ts` (annotate all 4 rows)
- Modify: `src/server/search/connectors/index.ts` (validate in real mode)
- Test: extend an existing registry expectation — `src/server/search/connectors/index.test.ts` if present, else add cases to `geo.test.ts`

**Interfaces:**
- Produces:
  - `SourceGeo = { country?: string; scope?: "anywhere" | "restricted"; regions?: string[] }`
  - `parseSourceGeo(source: { id: string; kind: "ats" | "board"; config: unknown }): SourceGeo` — **throws `SourceGeoConfigError`** when a board lacks `config.country` or an ATS row lacks a valid `config.geo.scope`.
- Consumes: seed shapes from Task 1; operator-confirmed priors (spec §6).

- [ ] **Step 1: Failing tests**

Append to `src/server/search/geo.test.ts`:

```ts
import { parseSourceGeo, SourceGeoConfigError } from "./geo";

describe("parseSourceGeo", () => {
  it("board with config.country returns { country }", () => {
    expect(parseSourceGeo({ id: "jobstreet", kind: "board", config: { country: "MY" } })).toEqual({ country: "MY" });
  });

  it("board without config.country throws", () => {
    expect(() => parseSourceGeo({ id: "jobstreet", kind: "board", config: {} })).toThrow(SourceGeoConfigError);
  });

  it("ats with scope anywhere returns { scope }", () => {
    expect(parseSourceGeo({ id: "gh-gitlab", kind: "ats", config: { geo: { scope: "anywhere" } } })).toEqual({
      scope: "anywhere",
    });
  });

  it("ats with scope restricted + regions returns both", () => {
    expect(
      parseSourceGeo({ id: "ashby-airwallex", kind: "ats", config: { geo: { scope: "restricted", regions: ["APAC"] } } }),
    ).toEqual({ scope: "restricted", regions: ["APAC"] });
  });

  it("ats without geo annotation throws", () => {
    expect(() => parseSourceGeo({ id: "gh-stripe", kind: "ats", config: { slug: "stripe" } })).toThrow(SourceGeoConfigError);
  });

  it("ats with an invalid scope value throws", () => {
    expect(() => parseSourceGeo({ id: "x", kind: "ats", config: { geo: { scope: "sometimes" } } })).toThrow(
      SourceGeoConfigError,
    );
  });
});
```

Run: `npx vitest run src/server/search/geo.test.ts` → Expected: FAIL (no export `parseSourceGeo`).

- [ ] **Step 2: Implement `parseSourceGeo`**

Append to `src/server/search/geo.ts`:

```ts
// Source-level geo annotation (spec §6), read from the sources row's config
// jsonb. Boards carry `country` (their whole inventory is one country — the
// Layer-A structural fact); ATS rows carry `geo.scope` — the operator-
// confirmed prior for reading a bare "Remote". Missing/invalid annotation on
// a real source is a configuration ERROR (fail loud), same posture as the
// registry's unknown-connector throw.

export interface SourceGeo {
  country?: string;
  scope?: "anywhere" | "restricted";
  regions?: string[];
}

export class SourceGeoConfigError extends Error {
  constructor(sourceId: string, detail: string) {
    super(`source "${sourceId}": ${detail}`);
    this.name = "SourceGeoConfigError";
  }
}

export function parseSourceGeo(source: { id: string; kind: "ats" | "board"; config: unknown }): SourceGeo {
  const config = (source.config ?? {}) as { country?: unknown; geo?: { scope?: unknown; regions?: unknown } };

  if (source.kind === "board") {
    if (typeof config.country !== "string" || config.country.length !== 2) {
      throw new SourceGeoConfigError(source.id, 'board source needs config.country (ISO-3166-1 alpha-2, e.g. "MY")');
    }
    return { country: config.country };
  }

  const scope = config.geo?.scope;
  if (scope !== "anywhere" && scope !== "restricted") {
    throw new SourceGeoConfigError(source.id, 'ats source needs config.geo.scope: "anywhere" | "restricted"');
  }
  const regions = Array.isArray(config.geo?.regions) ? (config.geo.regions as string[]) : undefined;
  return { scope, ...(regions ? { regions } : {}) };
}
```

Run: `npx vitest run src/server/search/geo.test.ts` → Expected: PASS.

- [ ] **Step 3: Annotate the seeds (operator-confirmed priors, spec §6)**

In `src/server/persistence/seed.ts`, extend each row's `config` (keep `connector`/`slug` as-is, add the new key):

| id | add to config |
|---|---|
| gh-stripe | `geo: { scope: "restricted" }` |
| gh-gitlab | `geo: { scope: "anywhere" }` |
| ashby-ramp | `geo: { scope: "restricted" }` |
| ashby-plaid | `geo: { scope: "restricted" }` |
| ashby-airwallex | `geo: { scope: "restricted", regions: ["APAC"] }` |
| ashby-deel | `geo: { scope: "anywhere" }` |
| gh-remote | `geo: { scope: "anywhere" }` |
| lever-toptal | `geo: { scope: "anywhere" }` |
| ashby-elevenlabs | `geo: { scope: "restricted" }` |
| ashby-perplexity | `geo: { scope: "restricted" }` |
| ashby-zapier | `geo: { scope: "anywhere" }` |
| ashby-supabase | `geo: { scope: "anywhere" }` |
| jobstreet | `country: "MY"` |

Example (first row): `config: { connector: "greenhouse", slug: "stripe", geo: { scope: "restricted" } }`.

In `src/server/persistence/seed-test.ts`:

```ts
export const testSourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "anywhere" } } },
  { id: "lever", name: "Lever", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "restricted" } } },
  { id: "ashby", name: "Ashby", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "restricted" } } },
  { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { query: "fixture", country: "MY" } },
];
```

- [ ] **Step 4: Validate at connector resolution (real mode)**

In `src/server/search/connectors/index.ts`, import `parseSourceGeo` from `../geo` and add the validation call inside `connectorForSource`, AFTER the doubles short-circuit (fixture sources are validated by run.ts's own `parseSourceGeo` call at stamping time — Task 6):

```ts
export function connectorForSource(source: SourceRow): SourceConnector {
  if (testDoublesEnabled()) return createFixtureConnector(source);
  parseSourceGeo(source); // fail loud on a mis-annotated real source before any fetch
  const key = (source.config as { connector?: string })?.connector ?? source.id;
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`No connector registered for source id "${source.id}" (connector key "${key}")`);
  return factory(source);
}
```

- [ ] **Step 5: Fix broken source fixtures**

Run: `npm test`
Expected: connector tests that build `SourceRow`s via local `source(overrides)` factories may now throw `SourceGeoConfigError`. For every failing factory (e.g. `src/server/search/connectors/greenhouse.test.ts:620` `config: { slug: "acme" }`), add the annotation: `config: { slug: "acme", geo: { scope: "restricted" } }` (ats) or `config: { ..., country: "MY" }` (board/jobstreet tests). Find them all with:

```bash
grep -rln "createTestDb\|SourceRow" src/server/search --include="*.test.ts"
```

Re-run `npm test` until green. Seed tests (`seed.test.ts`) asserting config shapes may need their expectations extended for the new keys.

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck` → Expected: PASS.

```bash
git add src/server/search/geo.ts src/server/search/geo.test.ts src/server/persistence/seed.ts src/server/persistence/seed-test.ts src/server/search/connectors
git commit -m "feat(sources): geo annotations (country/scope priors) + fail-loud parseSourceGeo validation"
```

---

### Task 4: jd-extract gains structured hiring-scope facts

**Files:**
- Modify: `src/server/score/jdFacts.ts` (two schema fields)
- Modify: `config/templates/jd-extract.md` (instruction)
- Test: extend `src/server/score/jdFacts.test.ts` if it exists (check with `ls src/server/score/*.test.ts`), else create it with the schema case below.

**Interfaces:**
- Produces: `JdFactsSchema` additionally allows `hiringScope?: "anywhere" | "restricted"` and `hiringCountries?: string[]`. `JdFacts` type widens accordingly. (Existing free-text `location`/`remotePolicy` unchanged.)

- [ ] **Step 1: Failing schema test**

Add to (or create) `src/server/score/jdFacts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JdFactsSchema } from "./jdFacts";

describe("JdFactsSchema hiring-scope fields", () => {
  it("accepts hiringScope + hiringCountries when stated", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
      hiringScope: "restricted",
      hiringCountries: ["APAC", "Singapore"],
    });
    expect(parsed.hiringScope).toBe("restricted");
    expect(parsed.hiringCountries).toEqual(["APAC", "Singapore"]);
  });

  it("both fields stay absent when unstated (do-not-guess contract)", () => {
    const parsed = JdFactsSchema.parse({ title: "Engineer", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] });
    expect(parsed.hiringScope).toBeUndefined();
    expect(parsed.hiringCountries).toBeUndefined();
  });

  it("rejects an invalid hiringScope value", () => {
    expect(() =>
      JdFactsSchema.parse({ title: "E", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [], hiringScope: "sometimes" }),
    ).toThrow();
  });
});
```

Run: `npx vitest run src/server/score/jdFacts.test.ts` → Expected: FAIL (unknown key stripped / undefined assertions fail on `hiringScope` acceptance case — zod strips unknown keys, so the first test's `parsed.hiringScope` is `undefined`).

- [ ] **Step 2: Schema fields**

In `src/server/score/jdFacts.ts`, inside `JdFactsSchema` after `remotePolicy` (line 21):

```ts
  // Spec 2026-07-12 §5 Layer C: STATED hiring geography only — never guessed.
  hiringScope: z.enum(["anywhere", "restricted"]).optional(),
  hiringCountries: z.array(z.string()).optional(), // countries/regions verbatim as the JD states them
```

Run: `npx vitest run src/server/score/jdFacts.test.ts` → Expected: PASS.

- [ ] **Step 3: Template instruction**

In `config/templates/jd-extract.md`, extend the `user:instructions` section — after "…salary range if stated, key responsibilities," insert:

```
hiring geography if the posting states it (hiringScope: "anywhere" when it
says it hires from anywhere/worldwide; "restricted" when it limits hiring to
named countries, regions, or a required timezone overlap — list those terms
verbatim in hiringCountries, e.g. ["United States"], ["APAC"], ["4h overlap
with PST"]),
```

(The verbatim-terms rule routes unmappable strings — including timezone
windows — to the resolver's `unknown` branch, per the locked TZ decision.)

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run src/server/score && npm run typecheck` → Expected: PASS.

```bash
git add src/server/score/jdFacts.ts src/server/score/jdFacts.test.ts config/templates/jd-extract.md
git commit -m "feat(score): jd-extract emits stated hiring scope (hiringScope/hiringCountries)"
```

---

### Task 5: The eligibility resolver (pure)

**Files:**
- Create: `src/server/score/eligibility.ts`
- Test: `src/server/score/eligibility.test.ts`

**Interfaces:**
- Consumes: `EligibilityTier`, `Tone` from `@/types`; `ParsedGeo`, `SourceGeo`, `parseLocationGeo` from `@/server/search/geo`; `JdFacts` from `./jdFacts`.
- Produces (Tasks 6–9 rely on these exact names):
  - `resolveEligibility(args: ResolveEligibilityArgs): { tier: EligibilityTier; evidence: string }`
  - `ResolveEligibilityArgs = { baseCountry: string; sourceKind: "ats" | "board"; sourceGeo: SourceGeo; location?: string; connectorGeo?: ParsedGeo; jdFacts?: Pick<JdFacts, "hiringScope" | "hiringCountries"> }`
  - `eligibilityTone(tier: EligibilityTier): Tone` — anywhere→`verified`, eligible→`good`, local→`good`, abroad→`warn`, unknown→`warn`.

- [ ] **Step 1: Failing precedence tests**

Create `src/server/score/eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EligibilityTier } from "@/types";
import { eligibilityTone, resolveEligibility } from "./eligibility";

const MY_BOARD = { baseCountry: "MY", sourceKind: "board" as const, sourceGeo: { country: "MY" } };
const ATS_ANYWHERE = { baseCountry: "MY", sourceKind: "ats" as const, sourceGeo: { scope: "anywhere" as const } };
const ATS_RESTRICTED = { baseCountry: "MY", sourceKind: "ats" as const, sourceGeo: { scope: "restricted" as const } };
const ATS_APAC = { baseCountry: "MY", sourceKind: "ats" as const, sourceGeo: { scope: "restricted" as const, regions: ["APAC"] } };

describe("eligibilityTone", () => {
  const table: [EligibilityTier, string][] = [
    ["anywhere", "verified"],
    ["eligible", "good"],
    ["local", "good"],
    ["abroad", "warn"],
    ["unknown", "warn"],
  ];
  it.each(table)("%s -> %s", (tier, tone) => {
    expect(eligibilityTone(tier)).toBe(tone);
  });
});

describe("resolveEligibility precedence", () => {
  // Layer A — board country stamp beats everything.
  it("MY board -> local, even with a remote-looking location", () => {
    expect(resolveEligibility({ ...MY_BOARD, location: "Remote" }).tier).toBe("local");
  });

  it("foreign board -> abroad", () => {
    expect(resolveEligibility({ baseCountry: "MY", sourceKind: "board", sourceGeo: { country: "SG" }, location: "Singapore" }).tier).toBe("abroad");
  });

  // Layer C — JD-stated facts beat connector strings and priors.
  it("JD hires anywhere -> anywhere, even on a restricted source", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote", jdFacts: { hiringScope: "anywhere" } }).tier).toBe("anywhere");
  });

  it("JD restricted to APAC -> eligible for MY", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, jdFacts: { hiringScope: "restricted", hiringCountries: ["APAC"] } }).tier).toBe("eligible");
  });

  it("JD restricted to United States -> abroad (geo-fenced remote folds into abroad)", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "Remote", jdFacts: { hiringScope: "restricted", hiringCountries: ["United States"] } }).tier).toBe("abroad");
  });

  it("JD restricted with an unmappable term (TZ window) -> unknown, term in evidence", () => {
    const r = resolveEligibility({ ...ATS_ANYWHERE, jdFacts: { hiringScope: "restricted", hiringCountries: ["4h overlap with PST"] } });
    expect(r.tier).toBe("unknown");
    expect(r.evidence).toContain("4h overlap with PST");
  });

  it("JD restricted, regions unstated -> unknown", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, jdFacts: { hiringScope: "restricted" } }).tier).toBe("unknown");
  });

  // Connector-geo layer.
  it("location worldwide -> anywhere", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote - Anywhere" }).tier).toBe("anywhere");
  });

  it("remote + APAC region -> eligible", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote — APAC" }).tier).toBe("eligible");
  });

  it("remote + US -> abroad", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "Remote - US" }).tier).toBe("abroad");
  });

  it("onsite in MY -> local", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Kuala Lumpur, Malaysia" }).tier).toBe("local");
  });

  it("onsite elsewhere -> abroad", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "New York, NY" }).tier).toBe("abroad");
  });

  // Prior layer — only reached by a bare "Remote".
  it("bare Remote + anywhere prior -> anywhere (the single sanctioned prior grant)", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "Remote" }).tier).toBe("anywhere");
  });

  it("bare Remote + restricted prior -> unknown (never eligible from a restricted prior alone)", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote" }).tier).toBe("unknown");
  });

  it("bare Remote + restricted prior with APAC regions -> eligible (Airwallex case)", () => {
    expect(resolveEligibility({ ...ATS_APAC, location: "Remote" }).tier).toBe("eligible");
  });

  // Fail-loud floor.
  it("empty location, no JD facts -> unknown with 'no geography stated'", () => {
    const r = resolveEligibility({ ...ATS_ANYWHERE, location: "" });
    expect(r.tier).toBe("unknown");
    expect(r.evidence).toBe("no geography stated");
  });

  it("every result carries a non-empty evidence string", () => {
    const cases = [
      resolveEligibility({ ...MY_BOARD, location: "Kuala Lumpur" }),
      resolveEligibility({ ...ATS_ANYWHERE, location: "Remote" }),
      resolveEligibility({ ...ATS_RESTRICTED, location: "Remote" }),
      resolveEligibility({ ...ATS_ANYWHERE, location: "New York, NY" }),
    ];
    for (const c of cases) expect(c.evidence.length).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run src/server/score/eligibility.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 2: Implement the resolver**

Create `src/server/score/eligibility.ts` (mirrors `legitimacy.ts`'s pure-resolver pattern — single tone table, documented precedence):

```ts
// Eligibility resolver (spec 2026-07-12-remote-local-eligibility-design.md
// §5) — pure. Precedence: board country stamp -> JD-stated facts ->
// connector-parsed geo -> source prior -> unknown. NO branch defaults to an
// eligible tier; the single sanctioned prior grant is an operator-confirmed
// `scope: "anywhere"` source lifting a bare "Remote" to `anywhere` (§6).
// `eligibilityTone` is the ONE server-side tier->tone table (assembleJob
// consumes it); caliber-ui/lib/eligibility.tsx mirrors it for UI/fixtures,
// same split as legitimacy.
import type { EligibilityTier, Tone } from "@/types";
import { parseLocationGeo, type ParsedGeo, type SourceGeo } from "@/server/search/geo";
import type { JdFacts } from "./jdFacts";

const TIER_TONE: Record<EligibilityTier, Tone> = {
  anywhere: "verified",
  eligible: "good",
  local: "good",
  abroad: "warn",
  unknown: "warn",
};

export function eligibilityTone(tier: EligibilityTier): Tone {
  return TIER_TONE[tier];
}

export interface ResolveEligibilityArgs {
  baseCountry: string; // ISO-3166-1 alpha-2 (profile.baseCountry)
  sourceKind: "ats" | "board";
  sourceGeo: SourceGeo; // parseSourceGeo(source)
  location?: string; // connector location string (jobs.location; "" treated as absent)
  connectorGeo?: ParsedGeo; // structured connector geo when a connector supplies it (RawPosting.geo)
  jdFacts?: Pick<JdFacts, "hiringScope" | "hiringCountries">;
}

// Region membership for the launch base country. "yes" only for regions that
// geographically include MY; unmapped terms are "unknown" — never a guess.
const REGIONS_INCLUDING_MY = new Set(["APAC", "SEA"]);
const REGIONS_EXCLUDING_MY = new Set(["EMEA", "AMERICAS", "ANZ"]);

// A stated hiring term ("Malaysia", "APAC", "United States", "4h overlap
// with PST") -> does it include the base country?
function termIncludesBase(term: string, baseCountry: string): "yes" | "no" | "unknown" {
  const geo = parseLocationGeo(term);
  if (geo.countryCode) return geo.countryCode === baseCountry ? "yes" : "no";
  if (geo.regionHint === "worldwide") return "yes";
  if (geo.regionHint && baseCountry === "MY") {
    if (REGIONS_INCLUDING_MY.has(geo.regionHint)) return "yes";
    if (REGIONS_EXCLUDING_MY.has(geo.regionHint)) return "no";
  }
  return "unknown";
}

export function resolveEligibility(args: ResolveEligibilityArgs): { tier: EligibilityTier; evidence: string } {
  const { baseCountry, sourceGeo, jdFacts } = args;

  // 1. Layer A — board country stamp (structural, exact).
  if (args.sourceKind === "board" && sourceGeo.country) {
    return sourceGeo.country === baseCountry
      ? { tier: "local", evidence: `${sourceGeo.country} board source` }
      : { tier: "abroad", evidence: `${sourceGeo.country} board source` };
  }

  // 2. Layer C — JD-stated hiring scope (authority over strings and priors).
  if (jdFacts?.hiringScope === "anywhere") {
    return { tier: "anywhere", evidence: "JD: hires from anywhere" };
  }
  if (jdFacts?.hiringScope === "restricted") {
    const terms = jdFacts.hiringCountries ?? [];
    if (terms.length === 0) return { tier: "unknown", evidence: "JD: restricted hiring, regions unstated" };
    const verdicts = terms.map((t) => ({ term: t, v: termIncludesBase(t, baseCountry) }));
    if (verdicts.some((x) => x.v === "yes")) {
      return { tier: "eligible", evidence: `JD: hires in ${verdicts.filter((x) => x.v === "yes").map((x) => x.term).join(", ")}` };
    }
    const unmapped = verdicts.filter((x) => x.v === "unknown");
    if (unmapped.length > 0) {
      // Curated-map drift signal (spec §9.6) — log, never guess.
      console.warn(`eligibility: unmapped hiring term(s): ${unmapped.map((x) => x.term).join("; ")}`);
      return { tier: "unknown", evidence: `JD: unmapped hiring restriction "${unmapped[0].term}"` };
    }
    return { tier: "abroad", evidence: `JD: hires only in ${terms.join(", ")}` };
  }

  // 3. Layer B — connector geo (structured if provided, else parsed string).
  const location = args.location && args.location.trim().length > 0 ? args.location : undefined;
  const geo = args.connectorGeo ?? parseLocationGeo(location);

  if (geo.regionHint === "worldwide") return { tier: "anywhere", evidence: `location: ${location ?? "worldwide"}` };

  if (geo.workMode === "remote") {
    if (geo.countryCode) {
      return geo.countryCode === baseCountry
        ? { tier: "eligible", evidence: `remote within ${geo.countryCode}` }
        : { tier: "abroad", evidence: `remote restricted to ${geo.countryCode}` };
    }
    if (geo.regionHint) {
      const v = termIncludesBase(geo.regionHint, baseCountry);
      if (v === "yes") return { tier: "eligible", evidence: `remote within ${geo.regionHint}` };
      if (v === "no") return { tier: "abroad", evidence: `remote restricted to ${geo.regionHint}` };
      console.warn(`eligibility: unmapped region hint "${geo.regionHint}"`);
      return { tier: "unknown", evidence: `unmapped remote region "${geo.regionHint}"` };
    }
    // 4. Bare "Remote" — the prior layer (the ONLY grants a prior may make).
    if (sourceGeo.scope === "anywhere") return { tier: "anywhere", evidence: "employer prior: hires anywhere" };
    if (sourceGeo.scope === "restricted" && sourceGeo.regions) {
      const v = sourceGeo.regions.map((r) => termIncludesBase(r, baseCountry));
      if (v.includes("yes")) return { tier: "eligible", evidence: `employer prior: hires in ${sourceGeo.regions.join(", ")}` };
    }
    return { tier: "unknown", evidence: 'bare "Remote" — employer hiring scope unproven' };
  }

  // Onsite/hybrid (or unstated mode) with a resolvable country.
  if (geo.countryCode) {
    return geo.countryCode === baseCountry
      ? { tier: "local", evidence: `location: ${location}` }
      : { tier: "abroad", evidence: `location: ${location}` };
  }

  // 5. Fail-loud floor.
  if (location) return { tier: "unknown", evidence: `unrecognized location "${location}"` };
  return { tier: "unknown", evidence: "no geography stated" };
}
```

- [ ] **Step 3: Run resolver tests**

Run: `npx vitest run src/server/score/eligibility.test.ts`
Expected: PASS (all precedence cases).

- [ ] **Step 4: Commit**

```bash
git add src/server/score/eligibility.ts src/server/score/eligibility.test.ts
git commit -m "feat(score): pure eligibility resolver — board stamp > JD facts > connector geo > prior > unknown"
```

---

### Task 6: Persist eligibility — jobs columns, ingest stamping, scan gating

**Files:**
- Modify: `src/server/persistence/schema.ts` (two `jobs` columns)
- Create: `drizzle/0005_*.sql` (generated, then hand-edited backfill)
- Modify: `src/server/search/connector.ts` (`RawPosting.geo?`), `src/server/search/connectors/jobstreet.ts` (all locations), `src/server/search/connectors/fixture.ts` (lever posting)
- Modify: `src/server/search/run.ts` (profile load, stamping, gating)
- Modify: `src/server/persistence/repos/__fixtures__/helpers.ts` (`insertJob` defaults)
- Test: `src/server/search/connectors/jobstreet.test.ts` (locations join), `src/app/spine.test.ts` (annotate stub sources, assert stamping)

**Interfaces:**
- Consumes: `profileRepo.get()` (Task 1), `parseSourceGeo` (Task 3), `resolveEligibility` (Task 5).
- Produces:
  - `jobs.eligibility: text NOT NULL` (tier), `jobs.eligibility_evidence: text NOT NULL` → `JobRow.eligibility`, `JobRow.eligibilityEvidence`.
  - `RawPosting.geo?: ParsedGeo` (optional; only set by connectors with structured signals — none yet in MVP).
  - `upsertMatchedPostings(matched, persona, profile)` — third param `ProfileRow`.
  - `scoreTopCandidates` gates `abroad` out of the top-30 pool when `profile.relocation === "stay"`.

- [ ] **Step 1: Schema columns + migration**

In `src/server/persistence/schema.ts`, inside the `jobs` table after `persona` (line 88):

```ts
  // Spec 2026-07-12 §4: eligibility tier relative to the profile, stamped at
  // ingest (Layers A+B), refreshed by the scoring path (Layer C). Facts stay
  // in `raw` + job_scores.jd_facts — the tier is recomputable, pure, no LLM.
  eligibility: text("eligibility", { enum: ["anywhere", "eligible", "local", "abroad", "unknown"] }).notNull(),
  eligibilityEvidence: text("eligibility_evidence").notNull(),
```

Run: `npm run db:generate` → produces `drizzle/0005_<name>.sql` with two `ADD COLUMN ... NOT NULL;` statements that would fail on a populated DB. **Hand-edit the generated SQL** to backfill-then-tighten (spec §4):

```sql
ALTER TABLE "jobs" ADD COLUMN "eligibility" text NOT NULL DEFAULT 'unknown';
ALTER TABLE "jobs" ADD COLUMN "eligibility_evidence" text NOT NULL DEFAULT 'predates eligibility classification';
ALTER TABLE "jobs" ALTER COLUMN "eligibility" DROP DEFAULT;
ALTER TABLE "jobs" ALTER COLUMN "eligibility_evidence" DROP DEFAULT;
```

(DROP DEFAULT keeps inserts fail-loud: every writer must supply values.)

- [ ] **Step 2: Fix `insertJob` fixture defaults, verify PGlite picks up the migration**

In `src/server/persistence/repos/__fixtures__/helpers.ts`, add to `insertJob`'s `.values({...})` defaults after `persona: "remote",`:

```ts
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
```

Run: `npm test` → any test inserting into `jobs` directly (not via the helper) fails on the NOT NULL columns; add the same two fields there. Expected after fixes: PASS.

- [ ] **Step 3: `RawPosting.geo` + JobStreet all-locations + fixture lever posting**

In `src/server/search/connector.ts`, add to `RawPosting` after `location?: string;`:

```ts
  // Structured geo a connector can supply beyond the location string (e.g.
  // a payload's explicit remote flag — none confirmed yet; see the capture
  // task). Absent = derive from `location` via parseLocationGeo.
  geo?: import("./geo").ParsedGeo;
```

In `src/server/search/connectors/jobstreet.ts` (line 367), replace the first-location-only read:

```ts
            location:
              item.locations
                ?.map((l) => l.label?.trim())
                .filter((l): l is string => Boolean(l))
                .join(" / ") || undefined,
```

Add a case to `src/server/search/connectors/jobstreet.test.ts` (follow its existing fixture-payload style): an item with `locations: [{ label: "Kuala Lumpur" }, { label: "Penang" }]` maps to `location: "Kuala Lumpur / Penang"`.

In `src/server/search/connectors/fixture.ts`, add to `POSTINGS` (the e2e abroad case — seed-test `lever` row is `scope: "restricted"`):

```ts
  lever: {
    sourceId: "lever",
    url: "https://jobs.lever.co/acme/senior-backend-engineer-payments",
    title: "Senior Backend Engineer, Payments",
    company: "Acme US",
    location: "New York, NY",
    description: "Payments platform team. Stack: Node.js, Postgres. Onsite in New York.",
  },
```

- [ ] **Step 4: Wire run.ts — profile load, ingest stamping, scan gating**

In `src/server/search/run.ts`:

1. Imports: add `profileRepo, type ProfileRow` from `@/server/persistence/repos/profile`; `parseSourceGeo` from `./geo`; `resolveEligibility` from `@/server/score/eligibility`.
2. In `startSearch`, right after the active-résumé check, load once and thread down: `const profile = await profileRepo.get();` (a missing row now aborts the run before any fetch — fail loud). Pass `profile` through `runFanOut` to both call sites below.
3. `upsertMatchedPostings` gains the param and stamps (spec §5 write points — Layers A+B at first sight):

```ts
async function upsertMatchedPostings(
  matched: { posting: RawPosting; source: SourceRow }[],
  persona: Persona,
  profile: ProfileRow,
): Promise<{ job: JobRow; source: SourceRow }[]> {
  const groups = groupByCollision(matched);
  const upserted: { job: JobRow; source: SourceRow }[] = [];
  for (const { canonical, canonicalSource, aliasUrls } of groups.values()) {
    const { tier, evidence } = resolveEligibility({
      baseCountry: profile.baseCountry,
      sourceKind: canonicalSource.kind,
      sourceGeo: parseSourceGeo(canonicalSource),
      location: canonical.location,
      connectorGeo: canonical.geo,
    });
    const job = await jobsRepo.upsertByDedupeKey({
      // ...existing fields unchanged...
      eligibility: tier,
      eligibilityEvidence: evidence,
      // ...
    });
    upserted.push({ job, source: canonicalSource });
  }
  return upserted;
}
```

(The ON CONFLICT set stays `lastSeenAt`/`aliases` only — eligibility freezes at first sight and is refreshed by the score path, Task 7.)

4. In `scoreTopCandidates`, replace `const topCandidates = candidates.slice(0, TOP_N_CANDIDATES);` with the gating (spec §5 scan hardening — persisted but unscored, they stop burning LLM slots):

```ts
  // relocation "stay": provably-abroad postings don't consume scoring slots.
  const pool = profile.relocation === "stay" ? candidates.filter((c) => c.job.eligibility !== "abroad") : candidates;
  const topCandidates = pool.slice(0, TOP_N_CANDIDATES);
```

(`profile` arrives as a new parameter threaded from `startSearch`, same as `persona`.)

- [ ] **Step 5: Fix spine + run tests**

Run: `npm test`
Expected failures: `src/app/spine.test.ts` (and any run.ts test) whose stub sources lack geo annotations or whose DB lacks a profile row. Fixes:
- Stub/inserted sources get `geo: { scope: "anywhere" }` (ats) / `country: "MY"` (board) in their `config`.
- Test DBs that exercise `startSearch` insert the profile row first: `await db.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });`
- Extend spine's post-scan assertion: upserted jobs carry a non-empty `eligibility` (`expect(row.eligibility).toBeTruthy()`; the fixture greenhouse posting — `location: "Remote"` on an `anywhere`-scope source — asserts `"anywhere"`, the jobstreet one — MY board — asserts `"local"`).

Re-run `npm test` until green.

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck` → Expected: PASS.

```bash
git add src/server/persistence/schema.ts drizzle src/server/persistence/repos/__fixtures__/helpers.ts src/server/search src/app/spine.test.ts
git commit -m "feat(scan): persist eligibility at ingest (Layers A+B) + gate abroad out of scoring slots under stay"
```

---

### Task 7: Score-path refresh (Layer C authority)

**Files:**
- Modify: `src/server/persistence/repos/jobs.ts` (add `updateEligibility`)
- Modify: `src/server/score/index.ts` (`scoreJob` gains `source` + `profile`, refreshes eligibility after jd-extract)
- Modify: `src/server/search/run.ts` (`scoreTopCandidates` call site), `src/server/score/evaluate.ts` (call site)
- Test: `src/server/persistence/repos/jobs.test.ts` (extend), plus the existing scoreJob/evaluate tests' call-site updates

**Interfaces:**
- Produces:
  - `jobsRepo.updateEligibility(id: string, tier: EligibilityTier, evidence: string): Promise<void>` — throws `Error` on unknown id (mirrors `updateDescription`'s fail-loud).
  - `scoreJob(args: { job: JobRow; source: SourceRow; profile: ProfileRow; resume: ResumeRow; llm: LlmClient }): Promise<JobScoreRow>` — **signature change**; both callers updated in this task.

- [ ] **Step 1: Failing repo test**

Add to `src/server/persistence/repos/jobs.test.ts`:

```ts
  it("updateEligibility overwrites tier + evidence and throws on unknown id", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db, {});
    const job = await insertJob(db, source.id, {});
    await repo.updateEligibility(job.id, "eligible", "JD: hires in APAC");
    const after = await repo.getById(job.id);
    expect(after?.eligibility).toBe("eligible");
    expect(after?.eligibilityEvidence).toBe("JD: hires in APAC");
    await expect(repo.updateEligibility("00000000-0000-0000-0000-000000000000", "unknown", "x")).rejects.toThrow();
  });
```

(Match the file's existing import style for `createTestDb`/helpers.) Run: `npx vitest run src/server/persistence/repos/jobs.test.ts` → Expected: FAIL (`updateEligibility` not a function).

- [ ] **Step 2: Implement `updateEligibility`**

In `src/server/persistence/repos/jobs.ts`, inside `createJobsRepo` (next to `updateDescription`), plus the singleton binding at the bottom:

```ts
    // Layer-C refresh (spec §5 write points): the scoring path re-resolves
    // with JD facts and overwrites the ingest-time stamp. Unknown id throws —
    // a refresh for a vanished row is a bug, not a no-op.
    async updateEligibility(id: string, tier: JobRow["eligibility"], evidence: string): Promise<void> {
      const [row] = await db
        .update(jobs)
        .set({ eligibility: tier, eligibilityEvidence: evidence })
        .where(eq(jobs.id, id))
        .returning({ id: jobs.id });
      if (!row) throw new Error(`updateEligibility: no job with id "${id}"`);
    },
```

```ts
  updateEligibility: (id, tier, evidence) => createJobsRepo(getDb()).updateEligibility(id, tier, evidence),
```

Run the repo test → PASS.

- [ ] **Step 3: `scoreJob` refresh**

In `src/server/score/index.ts`:
- Imports: add `jobsRepo` from `@/server/persistence/repos/jobs`, `SourceRow` type from `@/server/persistence/repos/sources`, `ProfileRow` type from `@/server/persistence/repos/profile`, `parseSourceGeo` from `@/server/search/geo`, `resolveEligibility` from `./eligibility`.
- Signature: `export async function scoreJob(args: { job: JobRow; source: SourceRow; profile: ProfileRow; resume: ResumeRow; llm: LlmClient }): Promise<JobScoreRow> { const { job, source, profile, resume, llm } = args; ...`
- After `const jdFactsResult = await extractJdFacts(llm, job.description);` (line 129), insert:

```ts
  // Layer C (spec §5): re-resolve with JD-stated facts — the authoritative
  // eligibility write. Same call also serves POST /api/jobs/:id/evaluate.
  const eligibility = resolveEligibility({
    baseCountry: profile.baseCountry,
    sourceKind: source.kind,
    sourceGeo: parseSourceGeo(source),
    location: job.location || undefined,
    jdFacts: jdFactsResult.data,
  });
  await jobsRepo.updateEligibility(job.id, eligibility.tier, eligibility.evidence);
```

- [ ] **Step 4: Update both callers**

- `src/server/search/run.ts` `scoreTopCandidates`: each candidate already carries `{ job, source }`; pass `source: candidate.source, profile` into `scoreJob({...})`.
- `src/server/score/evaluate.ts`: import `profileRepo`; after the résumé check add `const profile = await profileRepo.get();` and call `scoreJob({ job, source: found.source, profile, resume, llm })`.

- [ ] **Step 5: Fix scoreJob/evaluate tests**

Run: `npm test`
Expected failures: any test calling `scoreJob`/`evaluateJob` — add the new args (`source` from the test's inserted source row, `profile` from an inserted `{ id: "default", baseCountry: "MY", relocation: "stay" }` row or a literal `ProfileRow`-shaped object where the test doesn't touch the DB). Re-run until green. New assertion to add in one scoreJob test: after scoring a job whose stubbed jd-extract returns `hiringScope: "restricted", hiringCountries: ["United States"]`, the job row's `eligibility` is `"abroad"`.

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck` → Expected: PASS.

```bash
git add src/server/persistence/repos/jobs.ts src/server/persistence/repos/jobs.test.ts src/server/score src/server/search/run.ts
git commit -m "feat(score): scoring path refreshes eligibility with JD facts (Layer C authority)"
```

---

### Task 8: The wire flip — Job.eligibility, stats.excluded, feed predicate

**Files:**
- Modify: `src/types/index.ts` (`Job` + `SummaryStripStats`)
- Modify: `src/server/persistence/repos/jobs.ts` (`JobsQuery.eligibility[]`, drop `remote`, `countScored`)
- Modify: `src/server/search/jobsFeed.ts` (profile predicate + excluded)
- Modify: `src/features/feed/assemble.ts` (emit eligibility + tag)
- Modify: `src/app/api/jobs/route.ts` (drop `remote` param), `src/features/feed/client.ts` (drop `remote` from `GetJobsQuery`)
- Modify: `src/caliber-ui/fixtures/index.ts` (jobs + stats fixtures), `src/contract/registry.ts` (jobs query), `docs/architecture/api-contract.md`
- Test: `src/server/persistence/repos/jobs.test.ts`, `src/features/feed/assemble.test.ts` (or create), jobsFeed/route tests
- Regenerate: `contract/openapi.json`

**Interfaces:**
- Consumes: `eligibilityTone` (Task 5), `profileRepo` (Task 1), `JobRow.eligibility` (Task 6).
- Produces:
  - Wire `Job` gains `eligibility: Eligibility` (required). `SummaryStripStats` gains `excluded: z.number().int()`.
  - `JobsQuery`: `+ eligibility?: EligibilityTier[]`, `− remote`.
  - `jobsRepo.countScored(q: Omit<JobsQuery, "cursor" | "limit">): Promise<number>`.
  - Feed predicate: `stay` → `eligibility: ["anywhere", "eligible", "local", "unknown"]` + `excluded` = count of scoped `abroad`; `open` → no eligibility condition, `excluded: 0`.

- [ ] **Step 1: Contract**

`src/types/index.ts`:
- In `Job`, after `legitimacy: Legitimacy,` add `eligibility: Eligibility,`.
- In `SummaryStripStats`, after `flagged`, add `excluded: z.number().int(),` with comment `// jobs hidden by the eligibility predicate (spec §8) — 0 under relocation "open"`.

`src/contract/registry.ts` `/api/jobs` query object (line 181): delete `remote: z.boolean().optional(),`.

`docs/architecture/api-contract.md`: update the Job entity (+`eligibility`), `SummaryStripStats` (+`excluded`), §3 jobs query (−`remote`, note the server-derived predicate), and add the **three-axis definitions paragraph** (spec §3):

```
Three geography-ish axes coexist and must never be conflated:
`Source.persona` = scan routing (which source-set a run fans out to);
`Job.persona` = run provenance (stamped at upsert, immutable on re-sight);
`Job.eligibility` = posting geography relative to the operator profile
(anywhere | eligible | local | abroad | unknown), resolved deterministically
and refreshed by the scoring path.
```

- [ ] **Step 2: Repo — failing tests**

Add to `src/server/persistence/repos/jobs.test.ts`:

```ts
  it("filters by eligibility[] and counts the excluded scope", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db, {});
    const resume = await insertResume(db, {});
    const mk = async (eligibility: "anywhere" | "abroad" | "unknown") => {
      const job = await insertJob(db, source.id, { eligibility, eligibilityEvidence: "t" });
      await insertJobScore(db, job.id, resume.id, {});
      return job;
    };
    await mk("anywhere");
    await mk("abroad");
    await mk("unknown");

    const { items } = await repo.listScored({ eligibility: ["anywhere", "eligible", "local", "unknown"] });
    expect(items).toHaveLength(2);

    const excluded = await repo.countScored({ eligibility: ["abroad"] });
    expect(excluded).toBe(1);
  });
```

Run: `npx vitest run src/server/persistence/repos/jobs.test.ts` → Expected: FAIL.

- [ ] **Step 3: Repo implementation**

In `src/server/persistence/repos/jobs.ts`:
- `JobsQuery`: remove `remote?: boolean;` and add `eligibility?: EligibilityTier[];` (import `type EligibilityTier` from `@/types`), comment: `// server-derived from the profile (spec §8); repeatable tier filter`.
- `buildFilterConditions`: remove the `q.remote` branch; add:

```ts
  if (q.eligibility && q.eligibility.length > 0) conditions.push(inArray(jobs.eligibility, q.eligibility));
```

- New method inside `createJobsRepo` (+ singleton binding):

```ts
    // Excluded-count support (spec §8): jobs matching the scope that the
    // eligibility predicate hid — same joins as statsForQuery, count only.
    async countScored(q: Omit<JobsQuery, "cursor" | "limit">): Promise<number> {
      const conditions = buildFilterConditions(q);
      const latest = latestJobScores(db);
      const rows = await db
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      return rows.length;
    },
```

Run the repo test → PASS.

- [ ] **Step 4: Feed predicate in `jobsFeed.ts`**

In `src/server/search/jobsFeed.ts`, import `profileRepo` and `type EligibilityTier` and rework `listJobsFeed`:

```ts
const STAY_TIERS: EligibilityTier[] = ["anywhere", "eligible", "local", "unknown"];

export async function listJobsFeed(
  query: FeedQuery,
): Promise<{ items: Job[]; nextCursor: string | null; stats: SummaryStripStats }> {
  const profile = await profileRepo.get(); // fail loud — the predicate needs it
  const cutoff = await resolveIsNewCutoff(query.persona);

  const isNewFilter = query.isNew ? (cutoff ?? undefined) : undefined;
  const { isNew: _wireIsNew, cursor, limit, ...rest } = query;
  // relocation "stay" hides abroad; "open" applies no eligibility condition.
  const eligibility = profile.relocation === "stay" ? STAY_TIERS : undefined;
  const filterScope = { ...rest, isNew: isNewFilter, eligibility };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  const base = await jobsRepo.statsForQuery(filterScope, cutoff);
  const excluded =
    profile.relocation === "stay"
      ? await jobsRepo.countScored({ ...rest, isNew: isNewFilter, eligibility: ["abroad"] })
      : 0;

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats: { ...base, excluded },
  };
}
```

- [ ] **Step 5: assembleJob emits eligibility**

In `src/features/feed/assemble.ts`:
- Import `eligibilityTone` from `@/server/score/eligibility` and `type EligibilityTier` from `@/types`.
- Add a local label table (same pattern as `TIER_LABEL`):

```ts
// Presentation-only eligibility labels (spec §8). Tone comes from
// eligibilityTone (server/score) — never a second tone table.
const ELIGIBILITY_LABEL: Record<EligibilityTier, string> = {
  anywhere: "Work anywhere",
  eligible: "Hires from Malaysia",
  local: "Malaysia",
  abroad: "Relocation",
  unknown: "Eligibility unverified",
};
```

- Inside `assembleJob`, add the fail-loud guard after the legitimacy one, then wire the field + conditional tag (spec §8: suppressed on `local`):

```ts
  if (!job.eligibility || !job.eligibilityEvidence) {
    throw new Error(`jobs row ${job.id} has no eligibility — cannot assemble a Job (fail loud, no silent unknown)`);
  }
  const eligibility = {
    tier: job.eligibility,
    tone: eligibilityTone(job.eligibility),
    summary: job.eligibilityEvidence,
  };
```

and in the returned `Job.parse({...})`:

```ts
    tags: [
      { tone, label: TIER_LABEL[tier] },
      ...(eligibility.tier !== "local"
        ? [{ tone: eligibility.tone, label: ELIGIBILITY_LABEL[eligibility.tier] }]
        : []),
    ],
    // ...
    eligibility,
```

Add/extend `src/features/feed/assemble.test.ts`: a joined row with `eligibility: "anywhere"` assembles `eligibility.tier === "anywhere"`, `tone === "verified"`, and a second tag `"Work anywhere"`; a `local` row gets exactly one tag.

- [ ] **Step 6: Route + client param removal**

- `src/app/api/jobs/route.ts`: remove `"remote"` from `ALLOWED_PARAMS`, the `remote: BooleanParam,` schema line, and the `remote: searchParams.get("remote") ?? undefined,` parse line.
- `src/features/feed/client.ts`: remove `remote` from `GetJobsQuery` and its serialization if present.

- [ ] **Step 7: Fixtures + full sweep**

- `src/caliber-ui/fixtures/index.ts`: every job fixture gains an `eligibility` object. `caliber-ui/lib/eligibility.tsx` doesn't exist until Task 9, so in THIS task write literal tones — e.g. `eligibility: { tier: "anywhere", tone: "verified", summary: "employer prior: hires anywhere" }` — and Task 9 switches them to `eligibilityTone(...)`, mirroring how the legitimacy fixtures use `legitimacyTone`. Vary tiers across fixtures: at least one each of `anywhere`, `eligible`, `unknown`, and `local` (the JobStreet-style row).
- Stats fixtures (any `SummaryStripStats` literal in fixtures/stories/tests, incl. `EMPTY_STATS` in `src/app/feed/page.tsx`): add `excluded: 0` (or a nonzero demo value in Storybook fixtures).

Run: `npm test` → fix every remaining `Job.parse` / `SummaryStripStats` breakage the flip surfaces (route tests, e2e fixtures, stories' typecheck). Then:

Run: `npm run contract && npm run contract:check && npm run typecheck && npm test` → Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/server/persistence/repos/jobs.ts src/server/search/jobsFeed.ts src/features/feed src/app/api/jobs src/caliber-ui/fixtures src/app/feed/page.tsx src/contract/registry.ts contract/openapi.json docs/architecture/api-contract.md
git commit -m "feat(feed): Job.eligibility on the wire + relocation predicate + excluded count (persona chip param removed)"
```

---

### Task 9: Feed UI — pill, chip swap, excluded cell

**Files:**
- Create: `src/caliber-ui/lib/eligibility.tsx`
- Modify: `src/caliber-ui/compositions/Feed/JobRow.tsx`, `FilterChips.tsx`, `JobFeed.tsx`, `SummaryStrip.tsx`
- Modify: `src/caliber-ui/fixtures/index.ts` (switch to `eligibilityTone`)
- Test: `src/caliber-ui/compositions/Feed/JobRow.dom.test.tsx` (extend/create), `JobFeed.dom.test.tsx` (chip), `SummaryStrip.dom.test.tsx` (cell)
- Modify: `docs/superpowers/specs/2026-07-11-caliber-standalone-design.md` §11.8 (chip list), `docs/architecture/component-inventory.md` (EligibilityTag)
- Stories: extend `JobRow.stories.tsx` / `JobFeed.stories.tsx` with eligibility variants

**Interfaces:**
- Produces: `eligibilityTone(tier)`, `eligibilityLabel(tier)`, `EligibilityTag({ eligibility })` in `src/caliber-ui/lib/eligibility.tsx` (UI mirror of the server table — same split as legitimacy). `FeedFilter` value `"remote"` becomes `"anywhere"`.

- [ ] **Step 1: `EligibilityTag` (mirror `lib/legitimacy.tsx` exactly)**

Create `src/caliber-ui/lib/eligibility.tsx`:

```tsx
import * as React from "react";
import type { Eligibility, EligibilityTier, Tone } from "../../types";
import { Tag } from "../components/Tag";

// eligibilityTone — the UI-side tier->tone table (mirrors
// server/score/eligibility.ts, same split as legitimacy's two tables).
export function eligibilityTone(tier: EligibilityTier): Tone {
  const map: Record<EligibilityTier, Tone> = {
    anywhere: "verified",
    eligible: "good",
    local: "good",
    abroad: "warn",
    unknown: "warn",
  };
  return map[tier];
}

// eligibilityLabel — display label per tier (spec §8).
export function eligibilityLabel(tier: EligibilityTier): string {
  const map: Record<EligibilityTier, string> = {
    anywhere: "Work anywhere",
    eligible: "Hires from Malaysia",
    local: "Malaysia",
    abroad: "Relocation",
    unknown: "Eligibility unverified",
  };
  return map[tier];
}

// EligibilityTag — the eligibility pill beside the legitimacy pill.
// Suppressed by CALLERS when tier === "local" (stamping "Malaysia" on every
// JobStreet row is noise) — the component itself stays unconditional.
export function EligibilityTag({ eligibility }: { eligibility: Eligibility }) {
  return (
    <Tag tone={eligibility.tone} title={eligibility.summary}>
      {eligibilityLabel(eligibility.tier)}
    </Tag>
  );
}
```

- [ ] **Step 2: Failing DOM tests**

Extend/create `src/caliber-ui/compositions/Feed/JobRow.dom.test.tsx` (conventions: jsdom pragma, `afterEach(cleanup)`, typed inline fixture Job — copy an existing fixture job and set `eligibility`):

```tsx
  it("renders the eligibility pill for non-local tiers", () => {
    render(<JobRow job={{ ...baseJob, eligibility: { tier: "anywhere", tone: "verified", summary: "employer prior: hires anywhere" } }} onOpen={() => {}} onSave={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Work anywhere")).toBeInTheDocument();
  });

  it("suppresses the pill for local tier", () => {
    render(<JobRow job={{ ...baseJob, eligibility: { tier: "local", tone: "good", summary: "MY board source" } }} onOpen={() => {}} onSave={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByText("Malaysia")).not.toBeInTheDocument();
  });
```

(Adapt `JobRowProps` to the file's real prop names.) Add a `SummaryStrip.dom.test.tsx` case: `excluded: 12` renders `12` and the label `Not eligible · hidden`. Add a `JobFeed.dom.test.tsx` case: chip labeled `Work anywhere` filters to jobs whose `eligibility.tier === "anywhere"`.

Run: `npx vitest run src/caliber-ui/compositions/Feed` → Expected: FAIL.

- [ ] **Step 3: Implement UI changes**

- `JobRow.tsx`: import `EligibilityTag` from `../../lib/eligibility`; after `<LegitimacyTag legitimacy={job.legitimacy} />` (line 285) add:

```tsx
          {job.eligibility.tier !== "local" && <EligibilityTag eligibility={job.eligibility} />}
```

- `FilterChips.tsx`: `FeedFilter` union `"remote"` → `"anywhere"`; `FEED_FILTERS` entry `{ value: "remote", label: "Remote" }` → `{ value: "anywhere", label: "Work anywhere" }`. Update the §11.8 comment line to the new chip list.
- `JobFeed.tsx` `matchesFilter`: `case "remote": return job.persona === "remote";` → `case "anywhere": return job.eligibility.tier === "anywhere";`
- `SummaryStrip.tsx` `cells` array — insert after the flagged cell:

```ts
    { label: "Not eligible · hidden", value: stats.excluded },
```

- `src/caliber-ui/fixtures/index.ts`: replace the Task-8 literal tones with `eligibilityTone("<tier>")` (import from `../lib/eligibility`).

Run: `npx vitest run src/caliber-ui` → Expected: PASS.

- [ ] **Step 4: Stories + canon edit**

- Add one story variant each: `JobRow` with `eligibility: unknown` (warn pill) and `anywhere`; `JobFeed`'s populated story data now spans tiers; `SummaryStrip` story stats include `excluded: 12`.
- `docs/superpowers/specs/2026-07-11-caliber-standalone-design.md` §11.8: change the chip line to `All · New · Verified · Suspicious · Work anywhere · Fit ≥ 4` and append `(chip updated 2026-07-12: eligibility-based "Work anywhere" replaces persona-based "Remote" — see 2026-07-12-remote-local-eligibility-design.md §2.7)`.
- `docs/architecture/component-inventory.md`: add `EligibilityTag` (lib) with a one-line description.

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck` → Expected: PASS. Optionally eyeball in Storybook: `npm run storybook`.

```bash
git add src/caliber-ui docs/superpowers/specs/2026-07-11-caliber-standalone-design.md docs/architecture/component-inventory.md
git commit -m "feat(ui): eligibility pill, Work-anywhere chip (11.8 canon edit), excluded cell in SummaryStrip"
```

---

### Task 10: Profile page

**Files:**
- Modify: `src/app/AppShell.tsx` (enable the hidden row)
- Create: `src/caliber-ui/compositions/Profile/ProfileTargets.tsx`
- Test: `src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx`
- Create: `src/caliber-ui/compositions/Profile/ProfileTargets.stories.tsx`
- Create: `src/app/profile/page.tsx`
- Modify: `docs/architecture/component-inventory.md`

**Interfaces:**
- Consumes: `getProfile`/`updateProfile` (Task 1), `Profile`/`RelocationPref` from `@/types`, `Card`/`Select`/`Chip` primitives, the `PersonaToggle.tsx` segmented-pill pattern (quoted below — the pattern being mirrored), the `sources/page.tsx` busy/error/Retry pattern.
- Produces: `ProfileTargets({ profile, busy, onRelocationChange })` composition.

- [ ] **Step 1: Failing DOM test**

Create `src/caliber-ui/compositions/Profile/ProfileTargets.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ProfileTargets } from "./ProfileTargets";

afterEach(cleanup);

const profile = { baseCountry: "MY", relocation: "stay" as const, updatedAt: "2026-07-12T00:00:00.000Z" };

describe("ProfileTargets", () => {
  it("renders base country and both relocation options with stay selected", () => {
    render(<ProfileTargets profile={profile} busy={false} onRelocationChange={() => {}} />);
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open to relocate" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking the other option calls onRelocationChange with 'open'", () => {
    const onChange = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} onRelocationChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open to relocate" }));
    expect(onChange).toHaveBeenCalledWith("open");
  });

  it("busy disables both options", () => {
    render(<ProfileTargets profile={profile} busy={true} onRelocationChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toBeDisabled();
  });
});
```

Run: `npx vitest run src/caliber-ui/compositions/Profile` → Expected: FAIL (module missing).
Note: if `Chip` doesn't render `aria-pressed` natively, check `src/caliber-ui/components/Chip.tsx` — the SourceList toggle pattern (`aria-pressed` Button) is the fallback; adapt the test's role queries to whichever primitive renders, keeping the assertions' substance.

- [ ] **Step 2: Implement the composition**

Create `src/caliber-ui/compositions/Profile/ProfileTargets.tsx` — mirrors `PersonaToggle.tsx:135-160`'s pill (quoted pattern: two `variant="filter"` Chips inside an `inline-flex` wrapper on `var(--surface-sunken)` with `var(--radius-pill)`):

```tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import type { Profile, RelocationPref } from "../../../types";

export interface ProfileTargetsProps {
  profile: Profile;
  busy: boolean;
  onRelocationChange(v: RelocationPref): void;
}

const RELOCATION_OPTIONS: { value: RelocationPref; label: string }[] = [
  { value: "stay", label: "Stay in Malaysia" },
  { value: "open", label: "Open to relocate" },
];

// ProfileTargets — the /profile card (spec 2026-07-12 §7). Base country is a
// single-option Select (the honest extension point: a new country needs new
// local sources + token tables); relocation is a segmented pill mirroring
// PersonaToggle. Save-on-change is the PAGE's job — this stays controlled.
export function ProfileTargets({ profile, busy, onRelocationChange }: ProfileTargetsProps) {
  return (
    <Card padding="md" radius="lg" elevation="sm">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={{ font: "var(--type-label)", color: "var(--text-strong)", display: "block", marginBottom: 6 }}>
            Base country
          </label>
          <Select value={profile.baseCountry} onChange={() => {}} options={[{ value: "MY", label: "Malaysia" }]} />
        </div>
        <div>
          <label style={{ font: "var(--type-label)", color: "var(--text-strong)", display: "block", marginBottom: 6 }}>
            Relocation
          </label>
          <div
            style={{
              display: "inline-flex",
              gap: 4,
              padding: 3,
              background: "var(--surface-sunken)",
              borderRadius: "var(--radius-pill, 999px)",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {RELOCATION_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={profile.relocation === opt.value}
                onClick={() => onRelocationChange(opt.value)}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 8 }}>
            {profile.relocation === "stay"
              ? "Malaysia jobs + remote roles that hire from Malaysia."
              : "Also roles abroad that require relocating."}
          </div>
        </div>
      </div>
    </Card>
  );
}
```

(Adapt the `Select` prop names to the real primitive — read `src/caliber-ui/components/Select.tsx` first; if `Chip` lacks `aria-pressed`, wire `aria-pressed={selected}` via the primitive's pass-through or use the SourceList Button pattern instead. Keep the test honest with whichever renders.)

Run: `npx vitest run src/caliber-ui/compositions/Profile` → Expected: PASS.

- [ ] **Step 3: Enable the nav row + page**

`src/app/AppShell.tsx` (comment says "re-enabling a tab later is one line" — it's three):
- `ENABLED`: add `"profile"` → `new Set(["matches", "applied", "resume", "sources", "profile"])`
- `routeFor`: add `profile: "/profile",`
- `activeIdFor`: add `if (pathname.startsWith("/profile")) return "profile";`

Create `src/app/profile/page.tsx` (the `sources/page.tsx` load/busy/error/Retry pattern, save-on-change):

```tsx
"use client";
// Profile & targets page (spec 2026-07-12 §7): base country + relocation,
// save-on-change PUT /api/profile. Mirrors sources/page.tsx's busy/error/
// Retry pattern. A 404 here means an unseeded install — surfaced, not
// defaulted (fail loud).
import * as React from "react";
import { ProfileTargets } from "@/caliber-ui/compositions/Profile/ProfileTargets";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getProfile, updateProfile } from "@/features/profile/client";
import type { Profile, RelocationPref } from "@/types";

export default function ProfilePage() {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    try {
      setProfile(await getProfile());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the profile.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleRelocationChange(relocation: RelocationPref) {
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    try {
      setProfile(await updateProfile({ baseCountry: profile.baseCountry, relocation }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Profile & targets</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--danger-soft)",
              color: "var(--danger-ink)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="triangle-alert" size={16} />
              <span style={{ font: "var(--type-body)" }}>{error}</span>
            </div>
            <Button variant="secondary" iconLeft="refresh-cw" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
        {profile && <ProfileTargets profile={profile} busy={busy} onRelocationChange={handleRelocationChange} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Story + inventory**

Create `ProfileTargets.stories.tsx` (title `"Compositions/Profile/ProfileTargets"`, `layout: "padded"`; a controlled `Populated` demo flipping relocation locally, plus a `Busy` args story). Add `ProfileTargets` to `docs/architecture/component-inventory.md`.

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck` → Expected: PASS. Check `src/app/page-render.test.tsx`-style route smoke tests — if a table of routes exists there, add `/profile`.

```bash
git add src/app/AppShell.tsx src/app/profile src/caliber-ui/compositions/Profile docs/architecture/component-inventory.md
git commit -m "feat(profile): /profile page — ProfileTargets card, relocation pill, save-on-change"
```

---

### Task 11: E2E journey + system-architecture doc

**Files:**
- Create: `e2e/profile.spec.ts`
- Modify: `docs/architecture/system-architecture.md`

**Interfaces:**
- Consumes: everything shipped; doubles-mode fixtures (greenhouse→`anywhere`, lever→`abroad`, jobstreet→`local` from Tasks 3/6).

- [ ] **Step 1: Write the journey**

Create `e2e/profile.spec.ts` (conventions from `e2e/sources.spec.ts`: enter via sidebar, role/aria locators, restore state at the end). Journey — relocation flip re-scopes the feed with zero rescan:

```ts
import { expect, test } from "@playwright/test";

// Profile & targets journey (spec 2026-07-12 §7/§8): relocation is a feed
// predicate — flipping it re-scopes without a rescan. Doubles fixtures:
// greenhouse -> "anywhere" (remote persona), lever -> "abroad" (New York,
// restricted source), jobstreet -> "local". Under "stay" the abroad job is
// gated out of scoring; scanning under "open" scores it; flipping back to
// "stay" hides it and the excluded count moves.
test("profile: relocation toggle persists and re-scopes the feed", async ({ page }) => {
  // Enter via the sidebar (AppShell wiring).
  await page.goto("/feed");
  await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
  await expect(page).toHaveURL(/\/profile$/);

  const stay = page.getByRole("button", { name: "Stay in Malaysia" });
  const open = page.getByRole("button", { name: "Open to relocate" });
  await expect(stay).toBeVisible();

  // Flip to open; persists across reload (PUT round-trip, not local state).
  await open.click();
  await expect(page.getByText("Also roles abroad that require relocating.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Also roles abroad that require relocating.")).toBeVisible();

  // Scan under "open" so the abroad fixture job (Acme US, New York) scores.
  await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByText("Acme US", { exact: false })).toBeVisible({ timeout: 60_000 });

  // Flip back to "stay": the abroad job disappears, excluded count appears.
  await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
  await page.getByRole("button", { name: "Stay in Malaysia" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
  await expect(page.getByText("Acme US", { exact: false })).not.toBeVisible();
  await expect(page.getByText("Not eligible · hidden")).toBeVisible();

  // Restore default state for other specs.
  await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
  await expect(page.getByRole("button", { name: "Stay in Malaysia" })).toHaveAttribute("aria-pressed", "true");
});
```

(Adjust the scan-completion wait to the suite's existing pattern in `resume-scan-feed.spec.ts` — reuse its overlay-done/refetch waits rather than inventing new ones. The scan needs an active résumé; if other specs establish it order-dependently, reuse their bootstrap helper.)

- [ ] **Step 2: Run e2e**

Run: `npm run test:e2e -- profile.spec.ts` (needs native Postgres, port 3005 free)
Expected: PASS. If the abroad row never appears under "open", check the scoring path actually scored it (doubles LLM returns a fixed score) — the gating filter must only apply under `stay`.

- [ ] **Step 3: system-architecture.md**

Add to `docs/architecture/system-architecture.md`: `profile` table + `jobs.eligibility`/`eligibility_evidence` columns in the data-model section; the three-layer classification step in the scan flow (ingest stamp → score-path refresh); the feed predicate + excluded count in the read-model section. Cross-reference the spec file.

- [ ] **Step 4: Commit**

```bash
git add e2e/profile.spec.ts docs/architecture/system-architecture.md
git commit -m "test(e2e): relocation flip re-scopes feed without rescan; docs: eligibility in system architecture"
```

---

### Task 12: Ops — recompute + distribution scripts, payload captures, final gate

**Files:**
- Create: `src/server/score/recompute-eligibility.ts`, `src/server/score/eligibility-distribution.ts`
- Modify: `package.json` (two scripts)
- Create: `docs/architecture/connector-geo-capture.md` (findings log)

**Interfaces:**
- Consumes: `resolveEligibility`, `parseSourceGeo`, repos.
- Produces: `npm run eligibility:recompute` (pure re-resolve over stored facts — parser/prior improvements reach old rows, spec §5), `npm run eligibility:report` (the §11 measurement gate).

- [ ] **Step 1: Recompute script**

Create `src/server/score/recompute-eligibility.ts` (seed.ts self-exec pattern):

```ts
// Pure eligibility recompute over stored facts (spec §5 "explicit recompute
// script, never silent drift"): re-runs the resolver for every job using
// jobs.location + source annotations + the latest score row's jd_facts.
// Zero LLM cost. Run after changing geo.ts tables, priors, or the resolver.
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs, jobScores, sources } from "../persistence/schema";
import { profileRepo } from "../persistence/repos/profile";
import { parseSourceGeo } from "../search/geo";
import { resolveEligibility } from "./eligibility";
import type { JdFacts } from "./jdFacts";

export async function recomputeEligibility() {
  const db = getDb();
  const prof = await profileRepo.get();
  const rows = await db
    .select({ job: jobs, source: sources })
    .from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.sourceId));

  let changed = 0;
  for (const { job, source } of rows) {
    const [latestScore] = await db
      .select({ jdFacts: jobScores.jdFacts })
      .from(jobScores)
      .where(eq(jobScores.jobId, job.id))
      .orderBy(desc(jobScores.createdAt), desc(jobScores.id))
      .limit(1);
    const jdFacts = (latestScore?.jdFacts ?? undefined) as JdFacts | undefined;
    const { tier, evidence } = resolveEligibility({
      baseCountry: prof.baseCountry,
      sourceKind: source.kind,
      sourceGeo: parseSourceGeo(source),
      location: job.location || undefined,
      jdFacts,
    });
    if (tier !== job.eligibility || evidence !== job.eligibilityEvidence) {
      await db.update(jobs).set({ eligibility: tier, eligibilityEvidence: evidence }).where(eq(jobs.id, job.id));
      changed += 1;
    }
  }
  return { total: rows.length, changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recomputeEligibility()
    .then(({ total, changed }) => {
      console.log(`Recomputed eligibility for ${total} job(s); ${changed} changed.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Distribution script (the §11 measurement gate)**

Create `src/server/score/eligibility-distribution.ts`:

```ts
// Measurement gate (spec §11): tier distribution over the jobs table. If
// "unknown" dominates (> ~50%), prioritize the phase-2 aggregator + prior/
// parser tuning — numbers decide, not optimism.
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs } from "../persistence/schema";

async function report() {
  const db = getDb();
  const rows = await db
    .select({ eligibility: jobs.eligibility, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.eligibility);
  const total = rows.reduce((s, r) => s + r.n, 0);
  for (const r of rows.sort((a, b) => b.n - a.n)) {
    console.log(`${r.eligibility.padEnd(9)} ${String(r.n).padStart(5)}  ${((r.n / total) * 100).toFixed(1)}%`);
  }
  console.log(`total     ${String(total).padStart(5)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  report()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

Add to `package.json` scripts:

```json
    "eligibility:recompute": "tsx src/server/score/recompute-eligibility.ts",
    "eligibility:report": "tsx src/server/score/eligibility-distribution.ts",
```

- [ ] **Step 3: Payload captures (spec §5 — before trusting/widening connector fields)**

Run each and paste the relevant output into a new `docs/architecture/connector-geo-capture.md` (date it; these are the four repo-documented unknowns):

```bash
curl -s 'https://api.ashbyhq.com/posting-api/job-board/ramp' | head -c 2000        # isRemote? address? secondaryLocations?
curl -s 'https://api.lever.co/v0/postings/toptal?limit=1'                           # country? workplaceType?
curl -s 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs' | head -c 2000     # offices[]?
curl -s 'https://my.jobstreet.com/api/jobsearch/v5/search?siteKey=MY-Main&keywords=software+engineer&pageSize=2&page=1' | head -c 3000  # locations[] shape, workArrangements?
```

Record per connector: field present? reliable? **Only if confirmed**, widen that connector's payload interface and set `RawPosting.geo` from it — e.g. Ashby confirmed `isRemote: boolean` →

```ts
interface AshbyJob {
  // ...existing fields...
  isRemote?: boolean;
}
// in the mapping:
          geo: typeof j.isRemote === "boolean" && j.isRemote ? { workMode: "remote" as const } : undefined,
```

and mirror for Lever (`workplaceType` → `workMode`, `country` → `countryCode`) with a connector test per confirmed field. If a field is absent/unreliable, write that down in the capture doc and change nothing — the string parser remains the source.

- [ ] **Step 4: Live validation (operator-run, real mode)**

With real `DATABASE_URL` + `OPENROUTER_API_KEY`: run one remote scan + one local scan from the UI, then:

```bash
npm run eligibility:report
```

Paste the distribution into `docs/architecture/connector-geo-capture.md`. This is the phase-2 go/no-go input (aggregator connector prioritization).

- [ ] **Step 5: Final gate + commit**

Run: `npm run check` (typecheck + vitest + contract:check + build)
Expected: PASS.

```bash
git add src/server/score/recompute-eligibility.ts src/server/score/eligibility-distribution.ts package.json docs/architecture/connector-geo-capture.md src/server/search/connectors
git commit -m "feat(ops): eligibility recompute + distribution scripts; connector geo payload captures"
```

---

## Explicitly deferred (do NOT build in this plan)

- **Phase 2 — Remotive-class aggregator connector**: separate plan, gated on the Task-12 distribution numbers (spec §11).
- Hiredly/Maukerja/FastJobs, JobStreet-SG row, visa-sponsorship detection, per-source geo tags on the Sources page UI, feed re-ranking, "show excluded" audit toggle, multi-country base support.

## Plan-wide notes for implementers

- **The excluded count only counts scored-but-hidden jobs** (it joins `job_scores`) — under `stay`, abroad jobs are gated out of scoring, so the count moves mainly after scans that ran under `open`. This is by design (spec §8 + scan hardening); don't "fix" it by counting unscored rows.
- If `npm run db:generate` names migrations differently than `0004`/`0005`, keep drizzle's names — the plan's numbers are ordinals, not literals.
- Where a plan snippet's prop/field names collide with reality (e.g. `Select`'s API), reality wins — adjust the snippet's names, keep its substance, and say so in the commit body.
