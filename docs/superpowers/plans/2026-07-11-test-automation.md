# Full Test Automation for Caliber — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a five-tier test pyramid — hermetic by default (ephemeral Postgres + mocked OpenRouter + fixture connectors) plus one opt-in real-service smoke suite — so every documented status code, error path, and F1→F6 browser journey is exercised by automation.

**Architecture:** Tiers 1–3 (unit / contract-seam / API-integration) already exist on vitest+PGlite+in-process doubles and get hardened here (backlog #1 fixes + status-code matrix + shared SSE/waitFor utils). Tier 4 (Playwright browser E2E) is the main new build; it needs one product-code seam — a `CALIBER_TEST_DOUBLES=1` env flag checked at exactly the two existing factory functions (`getLlm`, `connectorForSource`) so a separately-booted `next dev` can run against real ephemeral Postgres with mocked LLM+connectors. Tier 5 (real smoke) and CI are last and small.

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript 5.6 · vitest 2 (node env) · Drizzle + `postgres`-js (SQLite/PGlite in dev/test) · `@electric-sql/pglite` · Playwright 1.61 (already a prod dep for `src/lib/pdf.ts`) · Zod 4 · OpenRouter via `openai` SDK.

## Global Constraints

- **Layering:** UI → `features/*` → `server/*`. Only `server/*` (and `src/lib/*` leaf modules it owns) may touch the DB or LLM. The E2E seam adds **zero** UI/features changes.
- **Fail loud (fintech rule):** no fallback defaults, no silent `0`/`""`/`unknown`. Validate at boundaries with `Schema.parse`. The test-doubles flag is honored only on exact string `"1"`; any other set value throws at the seam.
- **Contract is canon:** Zod schemas in `src/types` → `src/contract/registry.ts` → `contract/openapi.json` via `npm run contract`. Any change to a wire shape or a status code MUST update the registry and regenerate the committed JSON in the same task.
- **`ErrorEnvelope.error.code`** is a fixed enum in `src/types/index.ts`: `VALIDATION_ERROR | NOT_FOUND | CONFLICT | RUN_NOT_READY | PARSE_FAILED | EXTRACTION_FAILED | UPSTREAM_LLM_ERROR | PAYLOAD_TOO_LARGE`. Task 1.5 adds `INTERNAL`.
- **No new runtime deps** in Phase 1. Phase 2 adds `@playwright/test` (dev). Phase 3 adds nothing runtime. Phase 4 adds `@testing-library/react` + `jsdom` (dev).
- **Test runner:** `npm test` = `vitest run` and MUST stay hermetic (PGlite + doubles, no services). Smoke and E2E live under separate configs/scripts.
- **DB id columns are Postgres `uuid`** (`jobs`, `applications`, `applicationAnswers`, `tailoredResumes`, `jobScores`); only `sources.id` is `text`. A malformed uuid in a `WHERE id = ...` throws `invalid input syntax for type uuid` — this is the root cause of the backlog-#1 500s, and PGlite reproduces it.
- **No emojis. No `Co-Authored-By` trailer. Small surgical diffs.**

---

## File Structure

**Phase 1 — new files**
- `src/server/http/params.ts` — shared `UuidParam` Zod schema + `parseUuidParam` helper (404 on malformed).
- `src/server/persistence/repos/cursor.ts` — shared `InvalidCursorError` + generic `decodeCursor<T>` / `encodeCursor`.
- `src/app/api/__test-utils__/sse.ts` — extracted `readAllSseEvents`.
- `src/app/api/__test-utils__/poll.ts` — extracted `waitFor`.
- `src/contract/route-coverage.test.ts` — route↔contract completeness test.
- `src/lib/llm/templates.test.ts` — generalized template↔schema seam test for all 6 tasks.
- Modified: `src/types/index.ts` (add `INTERNAL` code), the two cursor repos, the `:id` path routes, `src/app/api/applications/route.ts`, both SSE routes, `contract/openapi.json`, `package.json`, `vitest.config.ts`.

**Phase 2 — new files**
- `src/lib/llm/scripted-fixtures.ts` — canonical scripted LLM responses (extracted from `spine.test.ts`).
- `src/server/search/connectors/fixture.ts` — deterministic fixture connector.
- `src/server/persistence/seed-test.ts` — `db:seed:test`.
- `playwright.config.ts`, `e2e/` (spec files + `globalSetup.ts`).
- Modified: `src/lib/llm/client.ts` (`getLlm` seam), `src/server/search/connectors/index.ts` (`connectorForSource` seam), `src/app/api/health/route.ts` + `src/contract/registry.ts` + `contract/openapi.json` (health `mode`), `package.json` (`test:e2e`, `db:seed:test`).

**Phase 3 — new files**
- `vitest.smoke.config.ts`, `src/smoke/setup.ts`, `src/smoke/*.smoke.test.ts`.
- `.github/workflows/ci.yml`.
- Modified: `package.json` (`smoke:real`, `check`), `vitest.config.ts` (exclude `*.smoke.test.ts`).

**Phase 4 — new files (optional)**
- `src/features/**/**.dom.test.tsx` with per-file `// @vitest-environment jsdom`.
- Modified: `package.json` devDeps.

---

# PHASE 1 — Harden tiers 2–3

No new runtime deps. Backlog #1 fixes are TDD-first (write the failing route test, apply the fix, go green). Deliverable: every documented status code executable; error paths no longer inspection-only.

---

### Task 1.1: Shared `UuidParam` guard — malformed `:id` → 404 (start with `GET /api/jobs/:id`)

**Files:**
- Create: `src/server/http/params.ts`
- Create/Test: `src/server/http/params.test.ts`
- Modify: `src/app/api/jobs/[id]/route.ts`
- Test: `src/app/api/jobs/[id]/route.test.ts` (create if absent)

**Interfaces:**
- Produces: `UuidParam: z.ZodString` and `isUuid(value: string): boolean` — used by Task 1.2 and every `:id` route in Task 1.4.

- [ ] **Step 1: Write the failing unit test for the helper**

Create `src/server/http/params.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isUuid } from "./params";

describe("isUuid", () => {
  it("accepts a canonical v4 uuid", () => {
    expect(isUuid("2f8a9c1e-4b6d-4f2a-9e3c-1a2b3c4d5e6f")).toBe(true);
  });
  it("rejects a non-uuid string", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/server/http/params.test.ts`
Expected: FAIL — cannot find module `./params`.

- [ ] **Step 3: Implement the helper**

Create `src/server/http/params.ts`:

```typescript
// Shared path-param validation. DB id columns are Postgres `uuid`
// (schema.ts) — a malformed value in `WHERE id = ...` throws
// `invalid input syntax for type uuid`, surfacing as a bare 500. Routes
// short-circuit malformed ids to 404 NOT_FOUND (the documented code for
// "no such id" — no contract change) before touching the DB.
import { z } from "zod";

export const UuidParam = z.string().uuid();

export function isUuid(value: string): boolean {
  return UuidParam.safeParse(value).success;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/server/http/params.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing route test**

Create `src/app/api/jobs/[id]/route.test.ts`:

```typescript
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET } = await import("./route");

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const res = await GET(new NextRequest("http://localhost/api/jobs/not-a-uuid"), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a well-formed but unknown uuid returns 404 NOT_FOUND", async () => {
    const id = "2f8a9c1e-4b6d-4f2a-9e3c-1a2b3c4d5e6f";
    const res = await GET(new NextRequest(`http://localhost/api/jobs/${id}`), params(id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 6: Run it and confirm the malformed-id case fails with a 500**

Run: `npx vitest run src/app/api/jobs/[id]/route.test.ts`
Expected: the "malformed id" test FAILS — the DB throws `invalid input syntax for type uuid`, so the handler rejects (500 / thrown error) instead of returning 404. The "unknown uuid" test PASSES (already handled by the existing `if (!joined)` branch).

- [ ] **Step 7: Add the guard to the route**

In `src/app/api/jobs/[id]/route.ts`, add the import and short-circuit at the top of `GET`, before `jobsRepo.getById`:

```typescript
import { isUuid } from "@/server/http/params";
```

```typescript
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }
  const joined = await jobsRepo.getById(id);
  if (!joined) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }
  // ...unchanged
```

- [ ] **Step 8: Run the route test to confirm green**

Run: `npx vitest run src/app/api/jobs/[id]/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add src/server/http/params.ts src/server/http/params.test.ts src/app/api/jobs/[id]/route.ts src/app/api/jobs/[id]/route.test.ts
git commit -m "fix(p1): malformed uuid :id -> 404 not 500 (jobs/:id) + shared UuidParam"
```

---

### Task 1.2: Safe cursor decode — garbage `?cursor=` → 422 (jobs + applications lists)

**Files:**
- Create: `src/server/persistence/repos/cursor.ts`
- Modify: `src/server/persistence/repos/jobs.ts` (lines 41–50 region), `src/server/persistence/repos/applications.ts` (lines 48–57 region)
- Modify: `src/app/api/jobs/route.ts`, `src/app/api/applications/route.ts` (add catch branch)
- Test: `src/app/api/jobs/route.test.ts` (extend), `src/app/api/applications/route.test.ts` (extend or create)

**Interfaces:**
- Produces: `class InvalidCursorError extends Error`, `encodeCursorId(id: string): string`, `decodeCursorId(cursor: string): { id: string }` — consumed by both cursor repos and both list routes.

- [ ] **Step 1: Write the failing route test (jobs list, garbage cursor)**

Add to `src/app/api/jobs/route.test.ts` inside the existing `describe`:

```typescript
  it("a malformed cursor returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await GET(req("?cursor=%%%not-base64-json%%%"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
```

- [ ] **Step 2: Run and confirm it fails with a 500**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: FAIL — `decodeCursor` does `JSON.parse(...)` with no try/catch; the route's `catch` only handles `ZodError`, so the parse error re-throws (500).

- [ ] **Step 3: Create the shared cursor module**

Create `src/server/persistence/repos/cursor.ts`:

```typescript
// Shared keyset-cursor codec. `decodeCursorId` throws a typed
// InvalidCursorError (never a raw SyntaxError) so list routes can map a
// garbage `?cursor=` to 422 VALIDATION_ERROR instead of leaking a 500.
export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Malformed cursor: ${cursor}`);
    this.name = "InvalidCursorError";
  }
}

export function encodeCursorId(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

export function decodeCursorId(cursor: string): { id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new InvalidCursorError(cursor);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { id?: unknown }).id !== "string") {
    throw new InvalidCursorError(cursor);
  }
  return { id: (parsed as { id: string }).id };
}
```

- [ ] **Step 4: Point both repos at the shared codec**

In `src/server/persistence/repos/jobs.ts`, delete the local `type Cursor`, `encodeCursor`, `decodeCursor` (lines ~41–50) and import instead:

```typescript
import { decodeCursorId, encodeCursorId } from "./cursor";
```

Replace the local call sites: `encodeCursor(row)` → `encodeCursorId(row.id)`, and `decodeCursor(q.cursor)` → `decodeCursorId(q.cursor)`. Do the identical replacement in `src/server/persistence/repos/applications.ts` (delete its local `Cursor`/`encodeCursor`/`decodeCursor` at lines ~48–57, import the shared codec, update call sites).

- [ ] **Step 5: Add the catch branch to both list routes**

In `src/app/api/jobs/route.ts`, add the import and extend the `catch` in `GET`:

```typescript
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
```

```typescript
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid jobs query.", err.issues);
    }
    if (err instanceof InvalidCursorError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
```

Apply the identical `InvalidCursorError` branch to the `GET` catch in `src/app/api/applications/route.ts`.

- [ ] **Step 6: Run the jobs test to confirm green + no regression**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: PASS (all prior tests + the new malformed-cursor test — the happy-path paging test still round-trips because `encodeCursorId`/`decodeCursorId` preserve the `{id}` shape).

- [ ] **Step 7: Write + run the same test for the applications list**

Add to `src/app/api/applications/route.test.ts` (create mirroring `jobs/route.test.ts`'s mock setup if it does not exist):

```typescript
  it("a malformed cursor returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await GET(new NextRequest("http://localhost/api/applications?cursor=@@bad@@"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
```

Run: `npx vitest run src/app/api/applications/route.test.ts` → Expected: PASS.

- [ ] **Step 8: Full suite green**

Run: `npm test`
Expected: PASS (no regressions from the repo refactor).

- [ ] **Step 9: Commit**

```bash
git add src/server/persistence/repos/cursor.ts src/server/persistence/repos/jobs.ts src/server/persistence/repos/applications.ts src/app/api/jobs/route.ts src/app/api/applications/route.ts src/app/api/jobs/route.test.ts src/app/api/applications/route.test.ts
git commit -m "fix(p1): garbage cursor -> 422 not 500 (shared InvalidCursorError codec)"
```

---

### Task 1.3: `POST /api/applications` — malformed `jobId` → 422

**Files:**
- Modify: `src/app/api/applications/route.ts` (the `RequestBody` schema)
- Test: `src/app/api/applications/route.test.ts` (extend)

**Interfaces:**
- Consumes: `UuidParam` from `src/server/http/params.ts` (Task 1.1).

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/applications/route.test.ts`:

```typescript
  it("a non-uuid jobId in the body returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/applications", {
        method: "POST",
        body: JSON.stringify({ jobId: "abc" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
```

(Import `POST` alongside `GET`: `const { GET, POST } = await import("./route");`.)

- [ ] **Step 2: Run and confirm it fails with a 500**

Run: `npx vitest run src/app/api/applications/route.test.ts`
Expected: FAIL — `jobId: z.string().min(1)` accepts `"abc"`, which reaches `markApplied` → `existsById("abc")` → uuid-column error → 500.

- [ ] **Step 3: Tighten the schema**

In `src/app/api/applications/route.ts`, change the `RequestBody.jobId` from `z.string().min(1)` to a uuid:

```typescript
import { UuidParam } from "@/server/http/params";
```

```typescript
const RequestBody = z.object({
  jobId: UuidParam,
  note: z.string().optional(),
  tailoredResumeId: z.string().optional(),
  answersId: z.string().optional(),
});
```

- [ ] **Step 4: Run and confirm green**

Run: `npx vitest run src/app/api/applications/route.test.ts`
Expected: PASS — `UuidParam.parse("abc")` throws a `ZodError`, caught by the existing `err instanceof ZodError` branch → 422. A syntactically-valid but unknown uuid still reaches `markApplied` → `UnknownJobError` → 404 (unchanged, still documented).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/applications/route.ts src/app/api/applications/route.test.ts
git commit -m "fix(p1): non-uuid jobId body -> 422 not 500 (POST /api/applications)"
```

---

### Task 1.4: Apply the `UuidParam` guard to every remaining `:id` path route

Same 500 mechanism as Task 1.1 at `applications/:id` (PATCH), `apply/answers/:id` (PATCH), `tailor/:id` (GET), `tailor/:id/finalize` (POST), `tailor/:id/pdf` (GET). CLAUDE.md rule: when fixing in one location, fix ALL similar locations.

**Files:**
- Modify: `src/app/api/applications/[id]/route.ts`, `src/app/api/apply/answers/[id]/route.ts`, `src/app/api/tailor/[id]/route.ts`, `src/app/api/tailor/[id]/finalize/route.ts`, `src/app/api/tailor/[id]/pdf/route.ts`
- Test: co-located `route.test.ts` for each (create if absent)

**Interfaces:**
- Consumes: `isUuid` from `src/server/http/params.ts`.

- [ ] **Step 1: Write one failing test per route (malformed id → 404)**

For each route file, create/extend its co-located `route.test.ts` with the mock scaffold (copy the `vi.hoisted` + `vi.mock("@/server/persistence/db")` + `createTestDb` block from `src/app/api/jobs/[id]/route.test.ts`) and this case, adjusting method + expected NOT_FOUND message:

```typescript
  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const res = await PATCH(  // or GET/POST per the route
      new NextRequest("http://localhost/api/applications/not-a-uuid", { method: "PATCH", body: "{\"note\":\"x\"}", headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
```

- [ ] **Step 2: Run all five and confirm each malformed-id case fails**

Run: `npx vitest run src/app/api/applications/[id] src/app/api/apply/answers/[id] src/app/api/tailor/[id]`
Expected: the malformed-id cases FAIL (500) for each route that reaches a uuid-column query.

- [ ] **Step 3: Add the guard to each route**

In each handler, immediately after `const { id } = await params;`, insert (using that route's existing `errorResponse` + the entity noun in the message):

```typescript
import { isUuid } from "@/server/http/params";
```

```typescript
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No <entity> with id "${id}".`);
  }
```

Entity nouns: `application` (applications/:id), `answers` (apply/answers/:id), `tailor run` (tailor/:id, finalize, pdf). Place the guard **before** any DB call and, where the handler reads the body first (PATCH routes), before `request.json()` is not required — put it right after `params` resolution; the malformed-id 404 should win over body parsing.

- [ ] **Step 4: Run and confirm green**

Run: `npx vitest run src/app/api/applications/[id] src/app/api/apply/answers/[id] src/app/api/tailor/[id]`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/applications/[id]/route.ts src/app/api/apply/answers/[id]/route.ts src/app/api/tailor/[id]/route.ts src/app/api/tailor/[id]/finalize/route.ts src/app/api/tailor/[id]/pdf/route.ts src/app/api/applications/[id]/route.test.ts src/app/api/apply/answers/[id]/route.test.ts src/app/api/tailor/[id]/route.test.ts src/app/api/tailor/[id]/finalize/route.test.ts src/app/api/tailor/[id]/pdf/route.test.ts
git commit -m "fix(p1): malformed uuid :id -> 404 at all remaining :id routes"
```

---

### Task 1.5: Add `INTERNAL` error code + regenerate contract (unblocks the SSE error-event test)

Both SSE routes currently emit `code: "CONFLICT"` for a *failed* run (`src/app/api/tailor/[id]/route.ts:50`, and the mirror in `search/[id]/route.ts`) — semantically wrong (backlog #2). Add an `INTERNAL` code and use it for run-crash failures.

**Files:**
- Modify: `src/types/index.ts` (ErrorEnvelope enum), `src/app/api/search/[id]/route.ts`, `src/app/api/tailor/[id]/route.ts`
- Modify: `contract/openapi.json` (regenerated)
- Test: `src/contract/registry.test.ts` already asserts byte-identical builds; add an enum-membership assertion.

- [ ] **Step 1: Write the failing test**

Add to `src/contract/registry.test.ts`:

```typescript
  it("ErrorEnvelope code enum includes INTERNAL for run-crash failures", async () => {
    const { ErrorEnvelope } = await import("@/types");
    const codes = ErrorEnvelope.shape.error.shape.code.options;
    expect(codes).toContain("INTERNAL");
  });
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/contract/registry.test.ts`
Expected: FAIL — `INTERNAL` not in the enum.

- [ ] **Step 3: Add the code**

In `src/types/index.ts`, add `"INTERNAL"` to the `ErrorEnvelope.error.code` enum list (append after `"PAYLOAD_TOO_LARGE"`).

- [ ] **Step 4: Use it for failed-run SSE in both routes**

In `src/app/api/tailor/[id]/route.ts` and `src/app/api/search/[id]/route.ts`, change the failed-run branch's `code: "CONFLICT"` to `code: "INTERNAL"` (the `row.status === "failed"` case only — leave the non-streamable/active-conflict branch as `CONFLICT`).

- [ ] **Step 5: Regenerate the contract**

Run: `npm run contract`
Then confirm the JSON changed as expected: `git diff --stat contract/openapi.json` (should show the enum addition).

- [ ] **Step 6: Run tests green**

Run: `npx vitest run src/contract/registry.test.ts`
Expected: PASS (including the byte-identical-build test).

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/app/api/search/[id]/route.ts src/app/api/tailor/[id]/route.ts contract/openapi.json src/contract/registry.test.ts
git commit -m "feat(p1): add INTERNAL error code; failed-run SSE uses it not CONFLICT"
```

---

### Task 1.6: Extract shared SSE + poll test utils, add the SSE `error`-event test

The `readAllSseEvents` helper (`src/app/api/search/[id]/route.test.ts:35–63`) and the `waitFor` helper (`src/app/spine.test.ts:183–191`) are duplicated concepts. Extract them; then add the missing terminal-`error`-event case.

**Files:**
- Create: `src/app/api/__test-utils__/sse.ts`, `src/app/api/__test-utils__/poll.ts`
- Modify: `src/app/api/search/[id]/route.test.ts` (import the util; add error-event test), `src/app/spine.test.ts` (import `waitFor` from the util)

**Interfaces:**
- Produces: `readAllSseEvents(res: Response): Promise<{ id: number; event: string; data: unknown }[]>`; `waitFor<T>(fn: () => Promise<T>, isDone: (v: T) => boolean, timeoutMs?: number): Promise<T>`.

- [ ] **Step 1: Create the SSE util (move, verbatim)**

Create `src/app/api/__test-utils__/sse.ts` with the exact body of `readAllSseEvents` from `src/app/api/search/[id]/route.test.ts:35–63`, `export`ed.

- [ ] **Step 2: Create the poll util (move, verbatim)**

Create `src/app/api/__test-utils__/poll.ts` with the exact body of `waitFor` from `src/app/spine.test.ts:183–191`, `export`ed.

- [ ] **Step 3: Rewire both call sites to import the utils**

In `src/app/api/search/[id]/route.test.ts`, delete the local `readAllSseEvents` and `import { readAllSseEvents } from "@/app/api/__test-utils__/sse";`. In `src/app/spine.test.ts`, delete the local `waitFor` and `import { waitFor } from "@/app/api/__test-utils__/poll";`.

- [ ] **Step 4: Run both to confirm no regression**

Run: `npx vitest run src/app/api/search/[id]/route.test.ts src/app/spine.test.ts`
Expected: PASS (behavior unchanged; utils just relocated).

- [ ] **Step 5: Write the failing SSE error-event test**

In `src/app/api/search/[id]/route.test.ts`, add a test that drives a run to `failed` and asserts a terminal `event: error` whose `data` parses as an `ErrorEnvelope` with `code: "INTERNAL"`. Use the file's existing run-setup pattern to insert a `search_runs` row with `status: "failed"` (no live handle), then:

```typescript
  it("a failed run streams a terminal error event with an INTERNAL ErrorEnvelope", async () => {
    // ...insert a failed search_run row `id` via the file's existing helper...
    const res = await GET(
      new NextRequest(`http://localhost/api/search/${id}`, { headers: { accept: "text/event-stream" } }),
      { params: Promise.resolve({ id }) },
    );
    const events = await readAllSseEvents(res);
    const last = events[events.length - 1];
    expect(last.event).toBe("error");
    const parsed = ErrorEnvelope.parse(last.data);
    expect(parsed.error.code).toBe("INTERNAL");
  });
```

- [ ] **Step 6: Run and confirm green**

Run: `npx vitest run src/app/api/search/[id]/route.test.ts`
Expected: PASS (relies on Task 1.5's `INTERNAL` change).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/__test-utils__/sse.ts src/app/api/__test-utils__/poll.ts src/app/api/search/[id]/route.test.ts src/app/spine.test.ts
git commit -m "test(p1): extract SSE/poll test utils + cover terminal error event"
```

---

### Task 1.7: DOCX-through-the-route integration test (`POST /api/resume`)

`tiny.docx`/`tiny.pdf` fixtures exist (`src/server/resume/__fixtures__/`) but are exercised only at the `extract-text` service level, not through the multipart route (the mammoth path).

**Files:**
- Test: `src/app/api/resume/route.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/resume/route.test.ts` a case that posts `tiny.docx` as `multipart/form-data` and asserts 200 + a parsed `Resume`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

  it("accepts a DOCX upload through the multipart route (mammoth path)", async () => {
    const bytes = readFileSync(join(__dirname, "../../../server/resume/__fixtures__/tiny.docx"));
    const form = new FormData();
    form.append("file", new File([bytes], "tiny.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const res = await POST(new NextRequest("http://localhost/api/resume", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBeDefined();
  });
```

Reuse the file's existing `vi.mock` scaffold (db → PGlite, llm → `makeMockLlm` scripted for `resume-extract`). If the existing file scripts the LLM, ensure the `resume-extract` fixture is present.

- [ ] **Step 2: Run and observe**

Run: `npx vitest run src/app/api/resume/route.test.ts`
Expected: FAIL initially only if the DOCX branch or mock wiring is missing; otherwise it confirms the path. If it fails on mock wiring, add the `resume-extract` scripted response mirroring the existing PDF test in the same file.

- [ ] **Step 3: Make it pass (wire the mock/fixture as needed — no product change expected)**

The route already accepts DOCX (mammoth is a dep). The work is test wiring only. Adjust the mock scaffold until green.

- [ ] **Step 4: Run green + commit**

Run: `npx vitest run src/app/api/resume/route.test.ts` → PASS.

```bash
git add src/app/api/resume/route.test.ts
git commit -m "test(p1): DOCX upload through the multipart /api/resume route"
```

---

### Task 1.8: Route↔contract completeness test

Catches drift between route handlers on disk and registered contract paths. `/api/docs` (the Scalar viewer) is intentionally not a contract endpoint and is allowlisted.

**Files:**
- Create: `src/contract/route-coverage.test.ts`

- [ ] **Step 1: Write the test**

Create `src/contract/route-coverage.test.ts`:

```typescript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocument } from "./generate";

const API_DIR = join(process.cwd(), "src/app/api");
// Not contract endpoints: the human-facing Scalar docs viewer.
const ALLOWLIST = new Set(["/api/docs"]);

// Walk src/app/api/**/route.ts -> { "/api/jobs/{id}": ["get", ...] }.
function routesOnDisk(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  function walk(dir: string, segments: string[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Next dynamic segment [id] -> {id} to match OpenAPI path templating.
        const seg = entry.startsWith("[") && entry.endsWith("]") ? `{${entry.slice(1, -1)}}` : entry;
        walk(full, [...segments, seg]);
      } else if (entry === "route.ts") {
        const path = `/api/${segments.join("/")}`;
        const src = readFileSync(full, "utf-8");
        const methods = new Set<string>();
        for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
          if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src)) methods.add(m.toLowerCase());
        }
        out.set(path, methods);
      }
    }
  }
  walk(API_DIR, []);
  return out;
}

describe("route <-> contract completeness", () => {
  const doc = buildDocument();
  const disk = routesOnDisk();

  it("every route handler on disk (except the allowlist) is registered in the contract", () => {
    const missing: string[] = [];
    for (const [path, methods] of disk) {
      if (ALLOWLIST.has(path)) continue;
      const contractMethods = doc.paths?.[path] ?? {};
      for (const method of methods) {
        if (!(method in contractMethods)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing, `unregistered routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every contract path+method has a handler on disk", () => {
    const orphans: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of ["get", "post", "patch", "put", "delete"]) {
        if ((item as Record<string, unknown>)[method] && !disk.get(path)?.has(method)) {
          orphans.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(orphans, `contract paths with no handler: ${orphans.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and observe**

Run: `npx vitest run src/contract/route-coverage.test.ts`
Expected: PASS — every disk route except `/api/docs` is registered, and every registered path has a handler. If it flags a genuine gap, either register the path in `registry.ts` (+ `npm run contract`) or add it to the allowlist with a justifying comment.

- [ ] **Step 3: Commit**

```bash
git add src/contract/route-coverage.test.ts
git commit -m "test(p1): route<->contract completeness gate"
```

---

### Task 1.9: Generalize the template↔schema seam test to all 6 LLM tasks

The `evalScores.test.ts` seam pattern (schema enum ↔ template prose ↔ frozen contract, zero LLM calls) currently covers only `match-score` legitimacy tiers. Generalize the cheapest defense against silent-swallow drift across `resume-extract | jd-extract | match-score | question-extract | question-answer | tailor`.

**Files:**
- Create: `src/lib/llm/templates.test.ts`

- [ ] **Step 1: Write the test**

Create `src/lib/llm/templates.test.ts`. For each of the 6 templates in `config/templates/`, assert the file exists and is non-empty, and — where a template enumerates a closed vocabulary that also lives in a Zod enum — assert the two agree. Start with the two known closed vocabularies (`match-score` legitimacy tiers and `verdict`), and assert file presence for the rest:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LegitimacyTier } from "@/types";

const TEMPLATES = ["resume-extract", "jd-extract", "match-score", "question-extract", "question-answer", "tailor"];

function read(name: string): string {
  return readFileSync(join(process.cwd(), "config", "templates", `${name}.md`), "utf-8");
}

describe("template <-> schema seam (no LLM calls)", () => {
  it("every TaskName has a non-empty template file", () => {
    for (const name of TEMPLATES) {
      expect(read(name).trim().length, `empty template: ${name}`).toBeGreaterThan(0);
    }
  });

  it("match-score.md tier prose lists exactly the frozen LegitimacyTier tokens", () => {
    const tierLine = read("match-score").match(/tier: one of([^\n]*)/);
    expect(tierLine).not.toBeNull();
    const tokens = [...tierLine![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(LegitimacyTier.options));
  });
});
```

Then, for each remaining template that has a closed enum in its response schema, add an assertion mirroring the `match-score` one. Inspect each response schema (search `src/server/**` for the Zod schema each `LlmClient.complete({ task })` call passes) and, where it has a `z.enum`, assert the template prose lists the same tokens. If a template has no closed vocabulary, the presence check suffices — document that with a one-line comment per task.

- [ ] **Step 2: Run and iterate to green**

Run: `npx vitest run src/lib/llm/templates.test.ts`
Expected: PASS. Any mismatch is a real drift bug — fix the template or the schema so they agree (do not weaken the assertion).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/templates.test.ts
git commit -m "test(p1): generalize template<->schema seam to all 6 LLM tasks"
```

---

### Task 1.10: Coverage measurement + contract-drift documentation

**Files:**
- Modify: `package.json` (devDep + scripts), `vitest.config.ts` (coverage config)

- [ ] **Step 1: Install the coverage provider**

Run: `npm install -D @vitest/coverage-v8@^2.1.9`
Expected: added to `devDependencies` (version aligned with vitest 2.1.x).

- [ ] **Step 2: Configure coverage + add scripts**

In `vitest.config.ts`, add to the `test` block:

```typescript
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['src/**'], exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__fixtures__/**', 'src/**/__test-utils__/**'] },
```

In `package.json` scripts add:

```json
    "test:coverage": "vitest run --coverage",
    "contract:check": "tsx src/contract/generate.ts && git diff --exit-code contract/openapi.json"
```

- [ ] **Step 3: Run coverage + the drift check**

Run: `npm run test:coverage`
Expected: PASS with a coverage table printed.
Run: `npm run contract:check`
Expected: exit 0 (no uncommitted drift — Task 1.5 already regenerated).

- [ ] **Step 4: Commit**

```bash
git add package.json vitest.config.ts package-lock.json
git commit -m "chore(p1): add v8 coverage + contract-drift check script"
```

---

# PHASE 2 — Test-profile seam + Playwright E2E

The one product-code change E2E needs: a `CALIBER_TEST_DOUBLES=1` flag at exactly two factory functions, plus a fixture connector, a shared scripted-fixtures module, a seed variant, and a health `mode` field. Then Playwright drives F1→F6 in real Chromium against the real Next app with real ephemeral Postgres + mocked LLM/connectors + real Chromium PDF.

---

### Task 2.1: Extract canonical scripted LLM fixtures into a shared module

**Files:**
- Create: `src/lib/llm/scripted-fixtures.ts`
- Modify: `src/app/spine.test.ts` (import from the shared module)

**Interfaces:**
- Produces: `scriptedFixtures: Partial<Record<TaskName, unknown>>` — the canonical "Jane Doe, Senior Backend Engineer, Payments" universe. Consumed by `getLlm` (Task 2.3) and `spine.test.ts`.

- [ ] **Step 1: Create the module**

Create `src/lib/llm/scripted-fixtures.ts`. Move the constants `RESUME_STORE`, `JD_FACTS`, `MATCH_SCORE`, `TAILOR_RESULT` (verbatim from `src/app/spine.test.ts:81–127`) plus the question-extract and question-answer scripts the spine uses, and assemble the map:

```typescript
import type { TaskName } from "./client";

export const RESUME_STORE = { /* ...verbatim from spine.test.ts... */ };
export const JD_FACTS = { /* ... */ };
export const MATCH_SCORE = { /* ... */ };
export const TAILOR_RESULT = { /* ... */ };
export const QUESTION_EXTRACT = { /* verbatim from spine.test.ts question script */ };
export const QUESTION_ANSWER = { /* verbatim from spine.test.ts answer script */ };

// Keyed by TaskName so makeMockLlm(scriptedFixtures) answers every F1-F6 call.
export const scriptedFixtures: Partial<Record<TaskName, unknown>> = {
  "resume-extract": RESUME_STORE,
  "jd-extract": JD_FACTS,
  "match-score": MATCH_SCORE,
  "question-extract": QUESTION_EXTRACT,
  "question-answer": QUESTION_ANSWER,
  tailor: TAILOR_RESULT,
};
```

- [ ] **Step 2: Rewire spine.test.ts to import them**

In `src/app/spine.test.ts`, delete the local constants and import them from `@/lib/llm/scripted-fixtures`.

- [ ] **Step 3: Run spine green**

Run: `npx vitest run src/app/spine.test.ts`
Expected: PASS (identical fixtures, just relocated).

- [ ] **Step 4: Commit**

```bash
git add src/lib/llm/scripted-fixtures.ts src/app/spine.test.ts
git commit -m "refactor(p2): extract canonical scripted LLM fixtures to shared module"
```

---

### Task 2.2: Fixture connector

**Files:**
- Create: `src/server/search/connectors/fixture.ts`
- Test: `src/server/search/connectors/fixture.test.ts`

**Interfaces:**
- Consumes: `SourceRow`, `SourceConnector`, `RawPosting`.
- Produces: `createFixtureConnector(source: SourceRow): SourceConnector`.

- [ ] **Step 1: Write the failing test**

Create `src/server/search/connectors/fixture.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createFixtureConnector } from "./fixture";

describe("fixture connector", () => {
  it("yields a deterministic RawPosting for a known source id", async () => {
    const source = { id: "greenhouse", kind: "ats", persona: "remote", enabled: true, config: {}, name: "Greenhouse" } as never;
    const conn = createFixtureConnector(source);
    const postings = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) {
      postings.push(p);
    }
    expect(postings).toHaveLength(1);
    expect(postings[0].sourceId).toBe("greenhouse");
    expect(postings[0].title).toContain("Backend Engineer");
  });

  it("yields nothing for an unknown source id", async () => {
    const source = { id: "unknown", kind: "board", persona: "local", enabled: true, config: {}, name: "x" } as never;
    const conn = createFixtureConnector(source);
    const postings = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) postings.push(p);
    expect(postings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run src/server/search/connectors/fixture.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement**

Create `src/server/search/connectors/fixture.ts`, reusing the spine's `POSTINGS` shape:

```typescript
// Deterministic connector for the CALIBER_TEST_DOUBLES seam (getLlm's peer
// for search). Mirrors spine.test.ts's stubConnector: one posting per
// source id, same "Senior Backend Engineer, Payments" universe so
// roleFuzzyMatch passes against the scripted résumé.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";

const POSTINGS: Record<string, RawPosting> = {
  greenhouse: {
    sourceId: "greenhouse",
    url: "https://boards.greenhouse.io/grab/jobs/6041234",
    title: "Senior Backend Engineer, Payments",
    company: "Grab",
    location: "Remote",
    description: "Own the payments ledger service. Stack: Node.js, Kafka, Postgres. Payments domain experience valued.",
  },
  jobstreet: {
    sourceId: "jobstreet",
    url: "https://www.jobstreet.com.my/job/senior-backend-engineer-payments-991234",
    title: "Senior Backend Engineer, Payments",
    company: "Local Fintech Sdn Bhd",
    location: "Kuala Lumpur, Malaysia",
    description: "Build the merchant payments platform. Stack: Node.js, Postgres. Payments domain experience valued.",
  },
};

export function createFixtureConnector(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover() {
      const posting = POSTINGS[source.id];
      if (posting) yield posting;
    },
  };
}
```

- [ ] **Step 4: Run green + commit**

Run: `npx vitest run src/server/search/connectors/fixture.test.ts` → PASS.

```bash
git add src/server/search/connectors/fixture.ts src/server/search/connectors/fixture.test.ts
git commit -m "feat(p2): deterministic fixture connector for test-doubles seam"
```

---

### Task 2.3: The seam — `getLlm` + `connectorForSource` honor `CALIBER_TEST_DOUBLES=1`

**Files:**
- Modify: `src/lib/llm/client.ts` (`getLlm`), `src/server/search/connectors/index.ts` (`connectorForSource`)
- Test: `src/lib/llm/client.test.ts` (create/extend), `src/server/search/connectors/index.test.ts` (extend)

- [ ] **Step 1: Write the failing seam tests**

Create/extend `src/lib/llm/client.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); });

describe("getLlm test-doubles seam", () => {
  it("returns the scripted mock when CALIBER_TEST_DOUBLES=1 (no API key needed)", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { getLlm } = await import("./client");
    const client = getLlm();
    const { z } = await import("zod");
    const res = await client.complete({ task: "jd-extract", messages: [], responseSchema: z.any() });
    expect(res.model).toBe("mock");
  });

  it("throws on an unexpected flag value (fail loud)", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "yes");
    const { getLlm } = await import("./client");
    expect(() => getLlm()).toThrow(/CALIBER_TEST_DOUBLES/);
  });
});
```

Add to `src/server/search/connectors/index.test.ts`:

```typescript
  it("returns the fixture connector when CALIBER_TEST_DOUBLES=1", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const { connectorForSource } = await import("./index");
    const conn = connectorForSource({ id: "greenhouse", kind: "ats", persona: "remote", enabled: true, config: {}, name: "x" } as never);
    const out = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) out.push(p);
    expect(out[0]?.sourceId).toBe("greenhouse");
  });
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run src/lib/llm/client.test.ts src/server/search/connectors/index.test.ts` → FAIL.

- [ ] **Step 3: Add the guard helper + seams**

In `src/lib/llm/client.ts`, add imports and a shared flag reader, then branch in `getLlm`:

```typescript
import { makeMockLlm } from "./mock";
import { scriptedFixtures } from "./scripted-fixtures";

// Fail-loud: honored only on exact "1"; any other set value throws.
export function testDoublesEnabled(): boolean {
  const v = process.env.CALIBER_TEST_DOUBLES;
  if (v === undefined || v === "") return false;
  if (v !== "1") throw new Error(`CALIBER_TEST_DOUBLES set to unexpected value "${v}" (only "1" enables test doubles)`);
  return true;
}
```

```typescript
export function getLlm(): LlmClient {
  if (testDoublesEnabled()) return makeMockLlm(scriptedFixtures);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const transport = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey });
  return buildClient(transport);
}
```

In `src/server/search/connectors/index.ts`:

```typescript
import { testDoublesEnabled } from "@/lib/llm/client";
import { createFixtureConnector } from "./fixture";
```

```typescript
export function connectorForSource(source: SourceRow): SourceConnector {
  if (testDoublesEnabled()) return createFixtureConnector(source);
  const factory = FACTORIES[source.id];
  if (!factory) throw new Error(`No connector registered for source id "${source.id}"`);
  return factory(source);
}
```

(`testDoublesEnabled` lives in the `src/lib/llm` leaf module and is imported by `server/*` — this respects layering; `server/*` may import from `src/lib`.)

- [ ] **Step 4: Run green + full suite**

Run: `npx vitest run src/lib/llm/client.test.ts src/server/search/connectors/index.test.ts`
Then: `npm test`
Expected: PASS (the flag defaults off, so existing hermetic tests using `vi.mock` are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/client.ts src/server/search/connectors/index.ts src/lib/llm/client.test.ts src/server/search/connectors/index.test.ts
git commit -m "feat(p2): CALIBER_TEST_DOUBLES seam at getLlm + connectorForSource (fail-loud)"
```

---

### Task 2.4: Health `mode` field + contract rev + boot guard

E2E asserts `mode: "doubles"` in the first second; a real run asserts `mode: "real"` — misconfiguration fails loudly instead of producing a confusing half-real run.

**Files:**
- Modify: `src/app/api/health/route.ts`, `src/contract/registry.ts`, `contract/openapi.json`
- Test: `src/app/api/health/route.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/app/api/health/route.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health", () => {
  it("reports mode 'doubles' when the flag is set", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const { GET } = await import("./route");
    const body = await (GET() as Response).json();
    expect(body).toEqual({ ok: true, mode: "doubles" });
  });

  it("reports mode 'real' when the flag is unset", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "");
    const { GET } = await import("./route");
    const body = await (GET() as Response).json();
    expect(body).toEqual({ ok: true, mode: "real" });
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run src/app/api/health/route.test.ts` → FAIL (`mode` absent).

- [ ] **Step 3: Update the route**

Rewrite `src/app/api/health/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { testDoublesEnabled } from "@/lib/llm/client";

export function GET() {
  return NextResponse.json({ ok: true, mode: testDoublesEnabled() ? "doubles" : "real" });
}
```

- [ ] **Step 4: Update the contract schema + regenerate**

In `src/contract/registry.ts`, change the `/api/health` 200 schema from `z.object({ ok: z.boolean() })` to `z.object({ ok: z.boolean(), mode: z.enum(["real", "doubles"]) })`. Run `npm run contract`. The existing `registry.test.ts` health-path assertion still passes.

- [ ] **Step 5: Run green + commit**

Run: `npx vitest run src/app/api/health/route.test.ts src/contract` → PASS.

```bash
git add src/app/api/health/route.ts src/contract/registry.ts contract/openapi.json src/app/api/health/route.test.ts
git commit -m "feat(p2): health reports mode real|doubles (E2E/smoke guard)"
```

---

### Task 2.5: `db:seed:test` script

**Files:**
- Create: `src/server/persistence/seed-test.ts`
- Modify: `package.json` (script)

- [ ] **Step 1: Create the seed variant**

Create `src/server/persistence/seed-test.ts` mirroring `seed.ts` but with fixture-safe config (the fixture connector ignores `config`, so any non-null value works):

```typescript
// Test-profile seed: same four sources as seed.ts, fixture-safe config so
// the CALIBER_TEST_DOUBLES fixture connector has rows to resolve from.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { sources } from "./schema";
import type { Db } from "./repos/db";

export const testSourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "lever", name: "Lever", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "ashby", name: "Ashby", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { query: "fixture" } },
];

export async function seedTestSources(db: Db) {
  return db.insert(sources).values(testSourceSeeds).onConflictDoNothing().returning();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedTestSources(getDb())
    .then((rows) => console.log(`Seeded ${rows.length} test source(s)`))
    .catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Add the script**

In `package.json` scripts add: `"db:seed:test": "tsx src/server/persistence/seed-test.ts"`.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add src/server/persistence/seed-test.ts package.json
git commit -m "feat(p2): db:seed:test for the E2E fixture profile"
```

---

### Task 2.6: Playwright config + ephemeral Postgres + `test:e2e` script

**Files:**
- Create: `playwright.config.ts`, `e2e/globalSetup.ts`
- Modify: `package.json` (devDep + script)

- [ ] **Step 1: Install the runner + browser**

Run: `npm install -D @playwright/test@^1.61.1`
Run: `npx playwright install chromium`
(Chromium serves both `src/lib/pdf.ts` and E2E.)

- [ ] **Step 2: Write `e2e/globalSetup.ts`**

Starts a throwaway tmpfs Postgres on port 5433, migrates, seeds the test profile. Fail loud if Docker is unavailable:

```typescript
import { execSync } from "node:child_process";

const DB_URL = "postgresql://postgres:test@localhost:5433/caliber_e2e";

export default async function globalSetup() {
  execSync(
    "docker run -d --rm --name caliber-e2e-db -e POSTGRES_PASSWORD=test -e POSTGRES_DB=caliber_e2e --tmpfs /var/lib/postgresql/data -p 5433:5432 postgres:16",
    { stdio: "inherit" },
  );
  // wait for readiness
  for (let i = 0; i < 30; i++) {
    try { execSync("docker exec caliber-e2e-db pg_isready -U postgres", { stdio: "ignore" }); break; }
    catch { execSync("sleep 1"); }
  }
  const env = { ...process.env, DATABASE_URL: DB_URL };
  execSync("npm run db:migrate", { stdio: "inherit", env });
  execSync("npm run db:seed:test", { stdio: "inherit", env });
  return async () => { execSync("docker stop caliber-e2e-db", { stdio: "inherit" }); };
}
```

- [ ] **Step 3: Write `playwright.config.ts`**

Boots the real Next app in the doubles profile:

```typescript
import { defineConfig } from "@playwright/test";

const DB_URL = "postgresql://postgres:test@localhost:5433/caliber_e2e";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup.ts",
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: false,
    env: { DATABASE_URL: DB_URL, CALIBER_TEST_DOUBLES: "1", OPENROUTER_API_KEY: "" },
  },
});
```

- [ ] **Step 4: Add the script + a smoke spec that proves the boot**

In `package.json` add: `"test:e2e": "playwright test"`. Create `e2e/boot.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("app boots in doubles mode", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, mode: "doubles" });
});
```

- [ ] **Step 5: Run it**

Run: `npm run test:e2e`
Expected: PASS — Docker Postgres comes up, migrations + test seed apply, `next dev` boots with the flag, health returns `mode: "doubles"`. (If Docker is unavailable locally, this is the expected failure point; document the Docker prerequisite.)

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e/globalSetup.ts e2e/boot.spec.ts package.json package-lock.json
git commit -m "feat(p2): playwright + ephemeral Postgres E2E harness (boot smoke green)"
```

---

### Task 2.7: E2E journeys F1–F2 (résumé ingest → dual-persona search → feed)

**Files:**
- Create: `e2e/f1-f2-ingest-search.spec.ts`

- [ ] **Step 1: Write the journey (empty DB → paste résumé → search → feed)**

Create `e2e/f1-f2-ingest-search.spec.ts`. Drive `/resume`: paste the "Jane Doe" résumé text, assert the parsed headline/skills/atsScore render; assert the upload-triggered dual-persona search starts and live progress renders (this exercises the real `EventSource` path in `features/search/client.ts`); navigate to `/feed` and assert the two fixture postings appear and SummaryStrip counts match. Use `page.getByRole`/`getByText` selectors grounded in the actual rendered components (verify against `src/app/resume/page.tsx` and `src/app/feed/page.tsx` while writing).

```typescript
import { test, expect } from "@playwright/test";

test("F1->F2: paste résumé, dual-persona search runs, feed populates", async ({ page }) => {
  await page.goto("/resume");
  await page.getByRole("textbox").fill("Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120));
  await page.getByRole("button", { name: /paste|submit|upload/i }).click();
  await expect(page.getByText(/Jane Doe/)).toBeVisible();
  // search kicks off + streams; then the feed has the two fixture postings
  await page.goto("/feed");
  await expect(page.getByText("Senior Backend Engineer, Payments")).toHaveCount(2);
});
```

- [ ] **Step 2: Run + refine selectors to green**

Run: `npm run test:e2e -- e2e/f1-f2-ingest-search.spec.ts`
Expected: PASS. Adjust selectors to the real DOM (do not change product code; if a needed element lacks an accessible name, note it as a Phase 4 a11y follow-up rather than editing components here).

- [ ] **Step 3: Commit**

```bash
git add e2e/f1-f2-ingest-search.spec.ts
git commit -m "test(p2): E2E F1->F2 ingest + dual-persona search + feed"
```

---

### Task 2.8: E2E journeys F3–F5 (detail + apply-out, questions, mark-applied + tracker)

**Files:**
- Create: `e2e/f3-f5-apply.spec.ts`

- [ ] **Step 1: Write the journeys**

Create `e2e/f3-f5-apply.spec.ts` covering: (F3) `/jobs/:id` Fit/Legitimacy/Breakdown tabs; the Apply action `href`/popup points at `applyUrl` — assert via `context.waitForEvent('page')` but do NOT navigate the external URL (fixture URLs are non-routable). (F4) `/jobs/:id/questions` paste tier: paste a form → questions render → answers draft with grounding chips → edit an answer → reload → edit persisted (`PATCH /api/apply/answers/:id`). (F5) Applied button → confirming → applied-disabled state; `/tracker` shows the row; patch note/stage; a second Applied on the same job surfaces the 409 gracefully. Seed a job id by reading the feed first (`page.goto('/feed')`, click the first row) rather than hardcoding a uuid.

- [ ] **Step 2: Run + refine to green**

Run: `npm run test:e2e -- e2e/f3-f5-apply.spec.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/f3-f5-apply.spec.ts
git commit -m "test(p2): E2E F3->F5 detail/apply-out, questions, tracker"
```

---

### Task 2.9: E2E journey F6 (tailor → accept subset → finalize → real Chromium PDF)

Closes the `src/lib/pdf.ts` "DEFERRED GATE" for the local case — real `htmlToPdf` runs in an automated test.

**Files:**
- Create: `e2e/f6-tailor-pdf.spec.ts`

- [ ] **Step 1: Write the journey**

Create `e2e/f6-tailor-pdf.spec.ts`: `/jobs/:id/tailor` → start → streamed progress renders → diff review → reject ≥1 change, accept the rest → finalize → download the PDF and assert the buffer starts with `%PDF` and content-type is `application/pdf`:

```typescript
import { test, expect } from "@playwright/test";

test("F6: tailor, accept a subset, finalize, download a real PDF", async ({ page }) => {
  // ...navigate from feed to a job's /tailor, run, reject one diff row, finalize...
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /download|pdf/i }).click(),
  ]);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(path!);
  expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
});
```

- [ ] **Step 2: Run to green (real Chromium PDF)**

Run: `npm run test:e2e -- e2e/f6-tailor-pdf.spec.ts`
Expected: PASS — the finalize renders via real in-process Chromium; the downloaded bytes start with `%PDF`.

- [ ] **Step 3: Full E2E suite green + commit**

Run: `npm run test:e2e` → all specs PASS.

```bash
git add e2e/f6-tailor-pdf.spec.ts
git commit -m "test(p2): E2E F6 tailor->finalize->real Chromium PDF"
```

---

# PHASE 3 — Real smoke + CI

---

### Task 3.1: Opt-in real-service smoke suite (`smoke:real`)

Catches real-integration surprises the hermetic suite structurally cannot. Manual, costs real tokens, never in CI. Fail-loud env gating (no silent skip — project rule).

**Files:**
- Create: `vitest.smoke.config.ts`, `src/smoke/setup.ts`, `src/smoke/openrouter.smoke.test.ts`, `src/smoke/jobstreet.smoke.test.ts`, `src/smoke/pdf.smoke.test.ts`, `src/smoke/postgres.smoke.test.ts`
- Modify: `package.json` (`smoke:real` script), `vitest.config.ts` (exclude `*.smoke.test.ts`)

- [ ] **Step 1: Exclude smoke from the default config**

In `vitest.config.ts` `test` block, add `exclude: ['src/**/*.smoke.test.ts', 'node_modules/**']`.

- [ ] **Step 2: Create the smoke config + fail-loud setup**

Create `vitest.smoke.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.smoke.test.ts"], setupFiles: ["src/smoke/setup.ts"], testTimeout: 120000 },
});
```

Create `src/smoke/setup.ts`:

```typescript
// Fail loud: real smoke needs real credentials. No silent skip.
if (!process.env.OPENROUTER_API_KEY) throw new Error("smoke:real requires OPENROUTER_API_KEY (real spend). Set it in .env and re-run.");
if (!process.env.DATABASE_URL) throw new Error("smoke:real requires DATABASE_URL pointing at a SCRATCH database.");
if (process.env.CALIBER_TEST_DOUBLES) throw new Error("smoke:real must NOT run with CALIBER_TEST_DOUBLES set — it exercises real services.");
```

- [ ] **Step 3: Write the 4 smoke tests**

- `openrouter.smoke.test.ts`: real `getLlm()` runs `jd-extract` on a 10-line fixture JD and `match-score` on it; assert the response Zod-parses, `model` matches `config/models.yml`, and `costUsd > 0` and `< 0.05`.
- `jobstreet.smoke.test.ts`: `createJobstreetConnector` with a real query; on success assert ≥1 `RawPosting`; on fetch/parse failure emit a loud `console.warn` and pass (soft-fail — scraping fragility is an accepted risk).
- `pdf.smoke.test.ts`: `htmlToPdf('<h1>ok</h1>')` → assert buffer starts with `%PDF`.
- `postgres.smoke.test.ts`: against real `DATABASE_URL`, run migrations then insert/select a `sources` row through `getDb()` (the `postgres`-js driver PGlite never exercises), then clean up.

- [ ] **Step 4: Add the script + verify the gate**

In `package.json` add: `"smoke:real": "vitest run --config vitest.smoke.config.ts"`.
Run without keys: `npm run smoke:real` → Expected: FAILS immediately with the setup guard message (this verifies fail-loud). Running with real keys is an operator step, not a plan step.

- [ ] **Step 5: Confirm default suite still hermetic + commit**

Run: `npm test` → PASS, and confirm no `*.smoke.test.ts` ran.

```bash
git add vitest.smoke.config.ts src/smoke/ package.json vitest.config.ts
git commit -m "feat(p3): opt-in real-service smoke suite (fail-loud env gate)"
```

---

### Task 3.2: CI workflow (inert until a remote exists) + local `check`

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (`check` script)

- [ ] **Step 1: Add the local one-command check**

In `package.json` add: `"check": "npm run typecheck && vitest run && npm run contract:check && npm run build"`.
Run: `npm run check` → Expected: PASS (typecheck, hermetic tests, no contract drift, build).

- [ ] **Step 2: Write the CI workflow**

Create `.github/workflows/ci.yml` with two jobs:

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run contract:check
      - run: npm run build
  e2e:
    needs: check
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: test, POSTGRES_DB: caliber_e2e }
        ports: ['5433:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:test@localhost:5433/caliber_e2e
      CALIBER_TEST_DOUBLES: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ hashFiles('package-lock.json') }}
      - run: npx playwright install --with-deps chromium
      - run: npm run db:migrate
      - run: npm run db:seed:test
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

Note: the `e2e` job uses the GitHub `services:` Postgres (not the Docker-in-globalSetup path); the Playwright `globalSetup` must skip its own `docker run` when `DATABASE_URL` already points at a running server. Guard `globalSetup.ts` with `if (process.env.CI) { /* migrate+seed only, no docker */ }`.

- [ ] **Step 3: Make globalSetup CI-aware**

Edit `e2e/globalSetup.ts` to run migrate+seed only (skip `docker run`/`docker stop`) when `process.env.CI` is set. `smoke:real` is deliberately absent from CI.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml e2e/globalSetup.ts package.json
git commit -m "feat(p3): CI workflow (check + e2e) + local npm run check"
```

---

# PHASE 4 — Component tests (optional; decide after Phase 2)

Only for B10 error states Playwright didn't cheaply reach. Cut entirely if Phase 2 covered them. Node stays the default vitest env; jsdom is opted in per-file.

---

### Task 4.1: jsdom + testing-library setup

**Files:**
- Modify: `package.json` (devDeps)

- [ ] **Step 1: Install**

Run: `npm install -D @testing-library/react@^16 @testing-library/jest-dom@^6 jsdom@^25`

- [ ] **Step 2: Prove the pragma works**

Create a throwaway `src/features/_env-check.dom.test.tsx` with `// @vitest-environment jsdom` at the very top that renders a trivial `<div>` via `@testing-library/react` and asserts it's in the document. Run `npx vitest run src/features/_env-check.dom.test.tsx` → PASS. Delete the throwaway file.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(p4): jsdom + testing-library (per-file env pragma)"
```

---

### Task 4.2: B10 error-state component tests

**Files:**
- Create: `src/features/**/<component>.dom.test.tsx` per uncovered B10 error state (JobFeed `error+retry`, AppliedButton `error-retry`, ResumeUpload `parse-error`/`extract-failed`/`PDF-error`, QuestionAssistant per-card error) — reference `docs/architecture/component-inventory.md` for exact prop names.

- [ ] **Step 1: For each uncovered error state, write a focused render test**

Each file starts with `// @vitest-environment jsdom`, renders the injectable-handler composition with forced error props (e.g. `error="..."`, `status="error"`, `onRetry={fn}`), asserts the error message renders and that clicking retry invokes `onRetry`. Use `@testing-library/react` `render` + `screen` + `fireEvent`. Ground every prop name in `component-inventory.md` — do not invent props.

- [ ] **Step 2: Run each to green**

Run: `npx vitest run src/features` (dom tests included; node tests unaffected).

- [ ] **Step 3: Commit**

```bash
git add src/features
git commit -m "test(p4): B10 error-state component tests (jsdom)"
```

---

## Self-Review

**Spec coverage (handoff §1–§9):**
- §2 Tier 1 coverage measurement → Task 1.10. ✓
- §2 Tier 2 route↔contract completeness → 1.8; contract-drift gate → 1.10; generalized template seam → 1.9. ✓
- §2 Tier 3 status-code matrix: backlog-#1 bold rows (uuid 404, garbage cursor 422, applications jobId 422) → 1.1–1.4; DOCX-through-route → 1.7; SSE error event + INTERNAL → 1.5–1.6; shared SSE/`waitFor` utils → 1.6. ✓ (Rows already covered — unknown-param/invalid-tier 422, stats correctness, happy paths — verified existing in `jobs/route.test.ts` and the 15 route tests; not re-authored.)
- §3 seam (two branches, fixture connector, shared scripted-fixtures, seed:test, health mode, fail-loud "1"-only + banner) → 2.1–2.5. ✓ (Boot banner: fold a one-line `console.warn` into Task 2.3's `testDoublesEnabled` first-true call if desired; noted, low priority.)
- §4 real smoke (4 tests, fail-loud gate) → 3.1. ✓
- §5 fixtures: shared scripted module → 2.1; fixture connector postings → 2.2. Wire-entity builders + deterministic-timestamp builders are **deferred** (not required for any task here; they belong to Phase-C backlog #4 — flagged, not silently dropped). 
- §6 CI + local `check` → 3.2. ✓
- §7 tooling calls (Playwright, in-process doubles, PGlite-for-vitest/real-PG-for-E2E, jsdom Phase 4) → honored in 2.6 / 3.2 / 4.x. ✓
- §8 manual runbook → unchanged; the plan's scripts (`test:e2e`, `smoke:real`, `check`, `contract:check`, `test:coverage`) match §8's table.
- §9 phasing → the four PHASE sections map 1:1.

**Placeholder scan:** E2E journey specs (2.7–2.9) intentionally leave selector details to be grounded against the live DOM at execution time — this is unavoidable without running the app, and each task's steps say to verify against the named page files and refine to green (not "TODO"). All product-code and test-util steps contain exact code.

**Type consistency:** `isUuid`/`UuidParam` (1.1) reused in 1.3/1.4; `InvalidCursorError`/`decodeCursorId`/`encodeCursorId` (1.2) reused in both repos and both list routes; `testDoublesEnabled` (2.3) reused in `connectorForSource` (2.3) and health (2.4); `scriptedFixtures` (2.1) consumed by `getLlm` (2.3); `readAllSseEvents`/`waitFor` (1.6) consumed by the SSE/spine tests. Names are consistent across tasks.

**Known deviations from the handoff (verified during recon, not guesses):**
- The handoff implied garbage cursor / `not-a-uuid` / `{jobId:"abc"}` all "bare 500 today." Recon confirmed: garbage cursor → 500 (no try/catch); uuid-shaped params → 500 **because id columns are Postgres `uuid`** (a text column would 404). `{jobId:"abc"}` → 500 via the same uuid mechanism. All three fixes stand; the mechanism is now exact.
- The jobs query schema **already** 422s on unknown params and invalid tiers (those matrix rows are done); the plan does not re-author them.
- The only route↔contract drift is `/api/docs` (Scalar viewer), allowlisted in 1.8 — the "docs not registered" gap is intentional, not a bug.
