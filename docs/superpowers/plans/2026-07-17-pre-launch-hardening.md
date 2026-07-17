# Pre-launch Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything code-side that must exist before ~5–20 invited friends touch caliber.fightbase.co: kill the two live `db.transaction()` landmines, add error boundaries + a crash beacon, the PDPA consent caption + delete-user runbook, operator password reset + self-serve change-password, the verdict-wrong Telegram feedback link, the weekly usage SQL, and the repo-tracked backup + alerting scripts.

**Architecture:** Small surgical additions on top of the merged membership-credits work (main @ 7ce6dae). No new subsystems: two repo rewrites (ordered single statements), one new beacon route + two `error.tsx` boundaries, two `tsx` CLI runbook scripts mirroring `seed.ts`'s entry idiom, one `PATCH` auth route reusing the existing password/session helpers, one kit-lib URL builder, and three ops scripts under a new repo-tracked `scripts/` directory.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Drizzle + SQLite (libsql `file:`), Zod contract in `src/types` → OpenAPI, Vitest (+ jsdom `// @vitest-environment` pragma for DOM tests), bash for ops scripts.

**Source spec (companion, authoritative for scope):** `docs/superpowers/plans/2026-07-16-pre-launch-hardening-plan.md` — its §Decisions are SETTLED by the operator (2026-07-16); do not re-litigate. This plan covers the CODE tasks (0, 4, 5, 6, 7, 8, the repo-script slices of 2 and 3, Task 1's optional health slice, and the tracked-risk-1 annotation). Everything operator-only lives in the "Operator runbook" section at the bottom — those steps are NOT TDD cycles.

**Line-number drift note:** the consolidation doc predates the credits merge. Citations re-verified against current main: `resumes.ts:16` and `delete-job.ts:60` are unchanged; `schema.ts:127` (résumé partial unique index) is unchanged; the url-check designed-fallback moved `run.ts:202` → **`run.ts:203`**; `users.plan` sits at `schema.ts:334`, `creditLedger` at `schema.ts:340-357`.

## Global Constraints

- **NEVER `db.transaction()`** — libsql `file:` driver corrupts state under concurrency (proven twice, 2026-07-16; `src/server/persistence/test-db.ts` header). Atomicity = ordered single statements, idempotent re-runs. **Two live violations get fixed in this plan (Task 0)** — one is the résumé-upload path every friend hits on launch evening. Task 0 also adds a source-scan gate test so a third violation can never land.
- **Contract-first:** `src/types` change → `npm run contract` → commit `contract/openapi.json` in the SAME commit.
- **Fail loud:** `Schema.parse` at boundaries; no fallback defaults, no silent `0`/`""`/`unknown`.
- **Kit canon:** compose the 13 primitives + `tokens.css`; legitimacy colour stays separate from the brand red.
- **`.env*` read-denied to agents** — shell-append only; box env edits are operator-only.
- **Layering:** UI → `features/*` → `server/*`; only `server/*` touches DB or LLM.
- **Branch:** `feat/pre-launch-hardening` from `main` (the credits work is already merged — 7ce6dae); per-task commits; every commit `tsc`-green (`npm run typecheck`).

## Wave order (collision-driven — consolidation doc §Sequencing)

Execution is sequential (one subagent per task); waves mark what is parallel-safe if you fan out.

| Wave | Tasks | Why this order |
|---|---|---|
| W1 | Task 0 | Blocker-adjacent; touches the résumé-upload path everything else assumes works. |
| W2 | Task 4 · Task 2 · Task 8 · Task 1 · Task 9 | Mostly disjoint files — EXCEPT Tasks 4 and 1 both edit `src/contract/registry.ts` + regen `contract/openapi.json`: run those two sequentially (4 then 1), never in parallel. |
| W3 | Task 7 · Task 5 | Task 7 consumes Task 4's `support.ts`. Task 5 is the first `package.json` toucher. |
| W4 | Task 6 | After Task 4 (`src/types` + registry serialization) and Task 5 (`package.json` collision). |
| W5 | Task 3 | Last: needs Task 2's DEPLOY.md section in place and Task 4's `[client-error]` log literal. |

Intra-plan collisions being serialized: Tasks 5 & 6 both edit `package.json`; Tasks 2 & 3 both edit `DEPLOY.md`; Tasks 4 & 6 (and 1) each edit `src/types/index.ts` / `src/contract/registry.ts` + regenerate `contract/openapi.json`.

---

### Task 0: Remove the two live `db.transaction()` landmines

**Wave:** 1 · **Tier:** Sonnet (med) — mechanical rewrite, but read the compensation-model comments carefully.

**Files:**
- Create: `src/server/persistence/no-db-transaction.test.ts` (source-scan gate)
- Modify: `src/server/persistence/repos/resumes.ts:15-27` (`insertReplacingActive` — the résumé-upload path)
- Modify: `src/server/jobs/delete-job.ts:60-66` (`deletePastedJob`'s delete block)
- Test: extend `src/server/persistence/repos/resumes.test.ts`; existing `src/server/jobs/delete-job.test.ts` must stay green unchanged

**Interfaces:**
- Consumes: `resumes_user_id_active_unique` partial unique index (`schema.ts:127`) — makes a crash-between visible (zero active rows, healed by the next upload; same compensation model the credits plan accepts).
- Produces: identical signatures — `insertReplacingActive(row: NewResume): Promise<ResumeRow>`, `deletePastedJob(jobId: string, userId: string): Promise<void>`. No caller changes.

- [ ] **Step 1: Write the failing source-scan gate.** Create `src/server/persistence/no-db-transaction.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Global constraint (pre-launch hardening): NEVER db.transaction() —
// @libsql/client's file: driver recreates its connection when an interactive
// transaction begins; concurrent transactions corrupt state (proven twice,
// 2026-07-16; test-db.ts header). Atomicity = ordered single idempotent
// statements. This test turns the constraint into a build gate: it fails on
// the two live landmines and on any future regression.

const SRC_ROOT = join(__dirname, "../.."); // src/

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...tsFilesUnder(p));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("no db.transaction() anywhere under src/", () => {
  it("finds zero call sites (comment lines excluded)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC_ROOT)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/\.transaction\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails on exactly the two landmines.**

Run: `npx vitest run src/server/persistence/no-db-transaction.test.ts`
Expected: FAIL — `offenders` contains exactly `.../src/server/persistence/repos/resumes.ts:16` and `.../src/server/jobs/delete-job.ts:60` (the other `.transaction` grep hits in `test-db.ts` and `credits/index.ts` are comment lines and are excluded).

- [ ] **Step 3: Add the concurrency test** to `src/server/persistence/repos/resumes.test.ts` (add `import { and, eq } from "drizzle-orm";` at the top; the file already imports `resumes`, `createTestDb`, `createResumesRepo`, `BOOTSTRAP_ADMIN_ID`):

```ts
it("concurrent insertReplacingActive calls never corrupt: exactly one active row survives", async () => {
  const db = await createTestDb();
  const repo = createResumesRepo(db);
  const base = {
    userId: BOOTSTRAP_ADMIN_ID,
    structured: {
      storeVersion: 2 as const,
      extractionPath: "text" as const,
      name: "A",
      contact: [],
      summary: "s",
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    },
    sourceKind: "paste" as const,
    isActive: true,
  };

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => repo.insertReplacingActive({ ...base, rawText: `resume ${i}` })),
  );

  // Losers may reject on the resumes_user_id_active_unique partial index —
  // fail-loud is acceptable; corruption is not.
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  const active = await db
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, BOOTSTRAP_ADMIN_ID), eq(resumes.isActive, true)));
  expect(active).toHaveLength(1);
});
```

(On the CURRENT transactional code this test is nondeterministic — it may pass, fail, or hang; that is the corruption profile itself. The deterministic red gate is Step 2. Do not chase a stable pre-fix failure here.)

- [ ] **Step 4: Rewrite `insertReplacingActive`.** In `src/server/persistence/repos/resumes.ts`, replace the current body (lines 15-27):

```ts
    async insertReplacingActive(row: NewResume): Promise<ResumeRow> {
      // Ordered single statements, NOT db.transaction() — the libsql file:
      // driver recreates its connection when an interactive transaction
      // begins and corrupts state under concurrency (test-db.ts header;
      // proven twice 2026-07-16). A crash between the two statements leaves
      // ZERO active rows for the user — visible (resume page 404s), healed
      // by the next upload. The resumes_user_id_active_unique partial index
      // (schema.ts:127) keeps "at most one active" true under any interleaving;
      // a concurrent loser fails loud on it instead of corrupting.
      await db
        .update(resumes)
        .set({ isActive: false })
        .where(and(eq(resumes.isActive, true), eq(resumes.userId, row.userId)));
      const [inserted] = await db
        .insert(resumes)
        .values({ ...row, isActive: true })
        .returning();
      return inserted;
    },
```

- [ ] **Step 5: Rewrite the `deletePastedJob` delete block.** In `src/server/jobs/delete-job.ts`, replace lines 60-66 (`await db.transaction(async (tx) => { ... });`):

```ts
  // Ordered single deletes, NOT db.transaction() (global constraint — the
  // libsql file: driver corrupts under concurrent interactive transactions).
  // Every statement is idempotent and the `jobs` row goes last, so a crash
  // mid-sequence re-runs cleanly: the guards above still resolve the job and
  // the earlier deletes are no-ops the second time. Order is FK-driven (see
  // the module doc-comment): dependents before `jobs`, tailored_resumes
  // before correlation_reports.
  await db.delete(applicationAnswers).where(eq(applicationAnswers.jobId, jobId));
  await db.delete(tailoredResumes).where(eq(tailoredResumes.jobId, jobId));
  await db.delete(correlationReports).where(eq(correlationReports.jobId, jobId));
  await db.delete(jobScores).where(eq(jobScores.jobId, jobId));
  await db.delete(jobs).where(eq(jobs.id, jobId));
```

- [ ] **Step 6: Run all three suites.**

Run: `npx vitest run src/server/persistence/no-db-transaction.test.ts src/server/persistence/repos/resumes.test.ts src/server/jobs/delete-job.test.ts`
Expected: PASS — gate finds zero offenders; all existing resume/delete-job behaviour tests green; the new concurrency test green.

- [ ] **Step 7: Commit.**

```bash
git add src/server/persistence/no-db-transaction.test.ts src/server/persistence/repos/resumes.ts src/server/persistence/repos/resumes.test.ts src/server/jobs/delete-job.ts
git commit -m "fix(persistence): remove db.transaction landmines from resume upload + job delete"
```

---

### Task 4: Error boundaries + crash beacon

**Wave:** 2 · **Tier:** Sonnet (med–high) — cross-file (types → server → features → UI) but every piece is specified below.

**Files:**
- Modify: `src/types/index.ts` (append `ClientErrorReport` after `AdminGrantRequest`, line 494)
- Create: `src/server/http/clientErrorLimit.ts` (per-IP limiter, mirrors `src/server/auth/registerLimit.ts`)
- Create: `src/app/api/client-error/route.ts`
- Create: `src/features/client-error/report.ts` (shared `reportClientError` helper)
- Create: `src/caliber-ui/lib/support.ts` (operator Telegram constant — Task 7 reuses it)
- Create: `src/app/error.tsx` and `src/app/(app)/error.tsx` (skip the thin `(auth)`/`(onboarding)` groups per the consolidation doc)
- Modify: `src/contract/registry.ts` (import + entity + `registerPath`), regen `contract/openapi.json`
- Test: `src/app/api/client-error/route.test.ts`, `src/app/error.test.tsx`

**Interfaces:**
- Consumes: `getSession()` (`src/server/auth/session.ts:28` — optional auth: an unauthenticated /login crash must still report); the `x-forwarded-for` first-entry idiom from `register/route.ts` (behind host Caddy every socket is the proxy).
- Produces: `ClientErrorReport` Zod schema; `checkClientErrorLimit(ip: string, now?: number): boolean`; `reportClientError(error: Error & { digest?: string }): void`; `OPERATOR_TELEGRAM_HANDLE` + `operatorTelegramUrl(): string`; one-line `console.error("[client-error]", <json>)` log — Task 3's classifier consumes the literal `[client-error]`.

- [ ] **Step 1: Write the failing route test.** Create `src/app/api/client-error/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSession: () => getSession() }));

import { POST } from "./route";
import { __resetClientErrorLimitForTests } from "@/server/http/clientErrorLimit";

function beaconRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://x/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const valid = {
  message: "boom",
  stack: "Error: boom\n  at page",
  url: "https://caliber.fightbase.co/feed",
  at: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(null);
  __resetClientErrorLimitForTests();
});

describe("POST /api/client-error", () => {
  it("204s and logs one [client-error] line with userId null when unauthenticated", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(beaconRequest(valid));
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledOnce();
    const [tag, json] = spy.mock.calls[0];
    expect(tag).toBe("[client-error]");
    expect(JSON.parse(json as string)).toMatchObject({ message: "boom", userId: null });
    spy.mockRestore();
  });

  it("attaches userId server-side when a session exists (never client-supplied)", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(beaconRequest(valid));
    expect(JSON.parse(spy.mock.calls[0][1] as string).userId).toBe("u1");
    spy.mockRestore();
  });

  it("413s a body over the size cap BEFORE parsing", async () => {
    const res = await POST(beaconRequest({ ...valid, stack: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("422s an invalid shape", async () => {
    const res = await POST(beaconRequest({ nope: true }));
    expect(res.status).toBe(422);
  });

  it("429s the 6th report from one IP inside a minute (XFF-keyed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      const res = await POST(beaconRequest(valid, { "x-forwarded-for": "203.0.113.7" }));
      expect(res.status).toBe(204);
    }
    const res = await POST(beaconRequest(valid, { "x-forwarded-for": "203.0.113.7" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/app/api/client-error/route.test.ts`
Expected: FAIL — cannot resolve `./route` / `@/server/http/clientErrorLimit` (modules not found).

- [ ] **Step 3: Implement the contract type.** In `src/types/index.ts`, append after `AdminGrantRequest` (line 494):

```ts
// ClientErrorReport — POST /api/client-error crash-beacon body (pre-launch
// hardening Task 4). userId is NEVER part of this schema — the route attaches
// it server-side from the session; a client-supplied id would be spoofable.
export const ClientErrorReport = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000),
  digest: z.string().max(200).optional(), // Next's server-component error digest when present
  at: z.string().datetime(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;
```

- [ ] **Step 4: Implement the limiter.** Create `src/server/http/clientErrorLimit.ts`:

```ts
// Per-IP limit for the crash beacon (pre-launch hardening Task 4): 5/minute
// fixed window, in-memory — same single-process assumption and idiom as
// src/server/auth/registerLimit.ts. Keyed off x-forwarded-for because behind
// the host Caddy every socket IS the proxy; without XFF the limiter would
// throttle all friends as one bucket.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

type Bucket = { windowStart: number; count: number };
const g = globalThis as unknown as { __caliberClientErrorLimiter?: Map<string, Bucket> };
g.__caliberClientErrorLimiter ??= new Map();
const buckets = g.__caliberClientErrorLimiter;

export function checkClientErrorLimit(ip: string, now = Date.now()): boolean {
  const b = buckets.get(ip);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

export function __resetClientErrorLimitForTests(): void {
  buckets.clear();
}
```

- [ ] **Step 5: Implement the route.** Create `src/app/api/client-error/route.ts`:

```ts
// POST /api/client-error — the crash beacon (pre-launch hardening Task 4).
// Order is load-bearing: per-IP limit → size cap (BEFORE JSON.parse) →
// Schema.parse → optional session (an unauthenticated /login crash must
// still report) → one-line [client-error] JSON log (alert-check.sh's
// threshold class matches that literal). userId is attached server-side
// only. Responds 204; the client fires-and-forgets via sendBeacon.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClientErrorReport, type ErrorEnvelope } from "@/types";
import { getSession } from "@/server/auth/session";
import { checkClientErrorLimit } from "@/server/http/clientErrorLimit";

const MAX_BODY_BYTES = 16_384; // schema maxima sum to ~12.2KB — headroom, not open-ended

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkClientErrorLimit(ip)) {
    return errorResponse(429, "RATE_LIMITED", "Too many error reports from this address.");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", `Report exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }
  try {
    const report = ClientErrorReport.parse(json);
    const session = await getSession();
    console.error("[client-error]", JSON.stringify({ ...report, userId: session?.id ?? null }));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid report shape.");
    throw err;
  }
}
```

- [ ] **Step 6: Run the route tests.**

Run: `npx vitest run src/app/api/client-error/route.test.ts`
Expected: PASS (all 5).

- [ ] **Step 7: Register the path + regen the contract.** In `src/contract/registry.ts`: add `ClientErrorReport` to the `@/types` import list (line 26-66) and to `entitySchemas` (line 68-108); append after the `/api/auth/session` block at the end of the file:

```ts
registry.registerPath({
  method: "post",
  path: "/api/client-error",
  summary: "Crash beacon — client error report (fire-and-forget; userId attached server-side)",
  request: { body: { content: { "application/json": { schema: ClientErrorReport } } } },
  responses: {
    204: { description: "Report accepted" },
    413: { description: "Report exceeds the size cap", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid report shape", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Per-IP report limit exceeded", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});
```

Run: `npm run contract`
Expected: `contract/openapi.json` gains `ClientErrorReport` + the `/api/client-error` path.

- [ ] **Step 8: Commit the beacon** (contract in the same commit — global constraint):

```bash
git add src/types/index.ts src/server/http/clientErrorLimit.ts src/app/api/client-error/ src/contract/registry.ts contract/openapi.json
git commit -m "feat(errors): ClientErrorReport crash-beacon route with size cap + per-IP limit"
```

- [ ] **Step 9: Write the failing boundary test.** Create `src/app/error.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reportClientError } = vi.hoisted(() => ({ reportClientError: vi.fn() }));
vi.mock("@/features/client-error/report", () => ({ reportClientError }));

import RootError from "./error";
import AppError from "./(app)/error";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("error boundaries (Task 4)", () => {
  const err = Object.assign(new Error("boom"), { digest: "d1" });

  it("root boundary reports the crash and offers retry + the operator's Telegram", () => {
    const reset = vi.fn();
    render(<RootError error={err} reset={reset} />);
    expect(reportClientError).toHaveBeenCalledWith(err);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
    const link = screen.getByRole("link", { name: /telegram/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("https://t.me/"));
  });

  it("(app) boundary reports and renders page-level framing (shell preserved by Next)", () => {
    render(<AppError error={err} reset={() => {}} />);
    expect(reportClientError).toHaveBeenCalledWith(err);
    expect(screen.getByText(/this page crashed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 10: Run to verify failure.**

Run: `npx vitest run src/app/error.test.tsx`
Expected: FAIL — `./error` / `./(app)/error` / `@/features/client-error/report` not found.

- [ ] **Step 11: Implement helper, support constant, and both boundaries.**

`src/caliber-ui/lib/support.ts`:

```ts
// Operator support channel (Decision 1, pre-launch consolidation): Telegram.
// Hardcoded constant because NEXT_PUBLIC_* env is not wired into the Docker
// build. The placeholder handle MUST be replaced with the operator's real
// handle before the first invite — operator runbook step 9 in the
// 2026-07-17 pre-launch-hardening plan.
export const OPERATOR_TELEGRAM_HANDLE = "caliber_operator_placeholder";

export function operatorTelegramUrl(): string {
  return `https://t.me/${OPERATOR_TELEGRAM_HANDLE}`;
}
```

`src/features/client-error/report.ts`:

```ts
// Crash-beacon client helper (Task 4). sendBeacon with a typed Blob is the
// primary path — it survives page unload; fetch(keepalive) is the fallback
// where sendBeacon is missing or refuses the payload. Never throws: a failed
// report must not cascade into the error UI itself.
import type { ClientErrorReport } from "@/types";

export function reportClientError(error: Error & { digest?: string }): void {
  const report: ClientErrorReport = {
    message: (error.message || "Unknown client error").slice(0, 2000),
    stack: error.stack?.slice(0, 8000),
    url: window.location.href.slice(0, 2000),
    digest: error.digest?.slice(0, 200),
    at: new Date().toISOString(),
  };
  const payload = JSON.stringify(report);
  try {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/client-error", blob)) return;
  } catch {
    // fall through to fetch
  }
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}
```

`src/app/error.tsx` (root boundary — sits INSIDE the root layout, whose 9 lines of static JSX can't throw, so `tokens.css` and kit primitives are available for free; catches `(app)/layout` / AppShell crashes):

```tsx
"use client";
import * as React from "react";
import { Button } from "@/caliber-ui/components/Button";
import { Card } from "@/caliber-ui/components/Card";
import { operatorTelegramUrl } from "@/caliber-ui/lib/support";
import { reportClientError } from "@/features/client-error/report";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg-app)" }}>
      <Card padding="lg" radius="lg" elevation="sm" style={{ width: 420 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>Caliber hit an error</div>
          <p style={{ font: "var(--type-body)", color: "var(--text-body)", margin: 0 }}>
            The crash was reported automatically. Reload to pick up where you left off.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={reset}>Try again</Button>
            <a
              href={operatorTelegramUrl()}
              target="_blank"
              rel="noreferrer"
              style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
            >
              Still broken? Message the operator on Telegram
            </a>
          </div>
        </div>
      </Card>
    </main>
  );
}
```

`src/app/(app)/error.tsx` (page crashes only — Next keeps AppShell/sidebar mounted because this boundary sits inside `(app)/layout.tsx`):

```tsx
"use client";
import * as React from "react";
import { Button } from "@/caliber-ui/components/Button";
import { operatorTelegramUrl } from "@/caliber-ui/lib/support";
import { reportClientError } from "@/features/client-error/report";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "14px 18px",
          borderRadius: "var(--radius-sm)",
          background: "var(--danger-soft)",
          color: "var(--danger-ink)",
        }}
      >
        <span style={{ font: "var(--type-body)" }}>This page crashed. The error was reported automatically.</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button variant="secondary" onClick={reset}>Try again</Button>
          <a
            href={operatorTelegramUrl()}
            target="_blank"
            rel="noreferrer"
            style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
          >
            Message the operator on Telegram
          </a>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Run + typecheck.**

Run: `npx vitest run src/app/error.test.tsx src/app/api/client-error/route.test.ts && npm run typecheck`
Expected: PASS + tsc green.

- [ ] **Step 13: Commit the boundaries.**

```bash
git add src/app/error.tsx "src/app/(app)/error.tsx" src/app/error.test.tsx src/features/client-error/report.ts src/caliber-ui/lib/support.ts
git commit -m "feat(errors): root + (app) error boundaries wired to the crash beacon"
```

---

### Task 2 (repo slice): Off-box backup script + runbook section

**Wave:** 2 · **Tier:** Sonnet (med). Bash, not vitest — verification is `bash -n` + a stub-bin dry-run (shown in full). The R2/age/rclone setup and the restore drill are operator-only (see Operator runbook).

**Files:**
- Create: `scripts/backup.sh` (new top-level `scripts/` directory — none exists today)
- Modify: `DEPLOY.md` (the "## Backup (ops floor before a second user)" section, lines 48-66)

**Interfaces:**
- Consumes: the `VACUUM INTO` + rm-first idiom already documented in DEPLOY.md:51-63; `/root/.config/caliber-backup.env` (operator-created; `AGE_RECIPIENT`, `RCLONE_REMOTE`).
- Produces: `/root/.local/state/caliber/backup-last-success` (epoch-seconds marker) — Task 3's stale-backup check reads it. `CALIBER_BACKUP_CONF` / `CALIBER_BACKUP_STATE_DIR` / `CALIBER_COMPOSE_DIR` env overrides exist ONLY as test seams.

- [ ] **Step 1: Write the script.** Create `scripts/backup.sh` (then `chmod +x scripts/backup.sh`):

```bash
#!/usr/bin/env bash
# Caliber nightly off-box backup (pre-launch hardening Task 2).
# Repo-tracked at scripts/backup.sh → deployed at /opt/caliber/scripts/backup.sh
# so push-to-deploy maintains it. Cron (operator runbook):
#   17 3 * * * /opt/caliber/scripts/backup.sh >> /var/log/caliber-backup.log 2>&1
#
# Pipeline: VACUUM INTO (consistent hot snapshot) → tar uploads → age-encrypt
# with the operator's PUBLIC key → rclone to R2. `.env.production` is NOT
# automated (manual copy to the password manager). The age PRIVATE key never
# touches this box — it lives on the Mac + the password manager.
#
# Config: /root/.config/caliber-backup.env (box-only, never in git):
#   AGE_RECIPIENT=age1...            # age public key
#   RCLONE_REMOTE=r2:caliber-backups # rclone remote:bucket (creds live in rclone config)
#
# The CALIBER_BACKUP_* overrides exist ONLY as test seams (stub-bin dry-run);
# production runs use the defaults.
set -euo pipefail

CONF="${CALIBER_BACKUP_CONF:-/root/.config/caliber-backup.env}"
STATE_DIR="${CALIBER_BACKUP_STATE_DIR:-/root/.local/state/caliber}"
COMPOSE_DIR="${CALIBER_COMPOSE_DIR:-/opt/caliber}"

[ -f "$CONF" ] || { echo "backup: missing config $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${AGE_RECIPIENT:?backup: AGE_RECIPIENT not set in $CONF}"
: "${RCLONE_REMOTE:?backup: RCLONE_REMOTE not set in $CONF}"

cd "$COMPOSE_DIR"
STAMP="$(date +%F)"
WORK="$(mktemp -d /tmp/caliber-backup.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# 1. Consistent DB snapshot. VACUUM INTO refuses to overwrite → rm first
#    (DEPLOY.md idiom: the job fails silently from night two otherwise).
docker compose exec -T app rm -f /var/lib/caliber/data/snapshot.db
docker compose exec -T app npx tsx -e "const{createClient}=require('@libsql/client');const c=createClient({url:process.env.DATABASE_URL});c.execute(\"VACUUM INTO '/var/lib/caliber/data/snapshot.db'\").then(()=>console.log('vacuum ok'))"
docker compose cp app:/var/lib/caliber/data/snapshot.db "$WORK/caliber-$STAMP.db"

# 2. Uploads (the volume is already in the nightly cron per the consolidation
#    doc — this adds the off-box + encrypted leg).
docker compose cp app:/var/lib/caliber/uploads "$WORK/uploads"
tar -czf "$WORK/uploads-$STAMP.tar.gz" -C "$WORK" uploads

# 3. Encrypt to the operator's age public key.
age -r "$AGE_RECIPIENT" -o "$WORK/caliber-$STAMP.db.age" "$WORK/caliber-$STAMP.db"
age -r "$AGE_RECIPIENT" -o "$WORK/uploads-$STAMP.tar.gz.age" "$WORK/uploads-$STAMP.tar.gz"

# 4. Off-box.
rclone copyto "$WORK/caliber-$STAMP.db.age" "$RCLONE_REMOTE/db/caliber-$STAMP.db.age"
rclone copyto "$WORK/uploads-$STAMP.tar.gz.age" "$RCLONE_REMOTE/uploads/uploads-$STAMP.tar.gz.age"

# 5. Success marker — alert-check.sh pages when this is older than ~26h.
mkdir -p "$STATE_DIR"
date +%s > "$STATE_DIR/backup-last-success"
echo "backup ok: caliber-$STAMP.db.age + uploads-$STAMP.tar.gz.age -> $RCLONE_REMOTE"
```

- [ ] **Step 2: Syntax check.**

Run: `bash -n scripts/backup.sh && chmod +x scripts/backup.sh && echo SYNTAX-OK`
Expected: `SYNTAX-OK`.

- [ ] **Step 3: Stub-bin dry-run** (proves pipeline order, marker write, and rclone leg without docker/age/rclone). Run from the repo root:

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/bin" "$SCRATCH/state" "$SCRATCH/compose"
export STUB_LOG="$SCRATCH/calls.log"

cat > "$SCRATCH/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
if [ "$1 $2" = "compose cp" ]; then
  src="${@: -2:1}"; dst="${@: -1}"
  if [[ "$src" == *uploads* ]]; then mkdir -p "$dst"; echo pdf > "$dst/file.pdf"; else echo dbbytes > "$dst"; fi
fi
exit 0
EOF
cat > "$SCRATCH/bin/age" <<'EOF'
#!/usr/bin/env bash
echo "age $*" >> "$STUB_LOG"
out=""; args=("$@")
for i in "${!args[@]}"; do [ "${args[$i]}" = "-o" ] && out="${args[$((i+1))]}"; done
echo encrypted > "$out"
EOF
cat > "$SCRATCH/bin/rclone" <<'EOF'
#!/usr/bin/env bash
echo "rclone $*" >> "$STUB_LOG"
EOF
chmod +x "$SCRATCH/bin/"*
printf 'AGE_RECIPIENT=age1testkey\nRCLONE_REMOTE=r2:caliber-backups\n' > "$SCRATCH/backup.env"

PATH="$SCRATCH/bin:$PATH" \
CALIBER_BACKUP_CONF="$SCRATCH/backup.env" \
CALIBER_BACKUP_STATE_DIR="$SCRATCH/state" \
CALIBER_COMPOSE_DIR="$SCRATCH/compose" \
bash scripts/backup.sh

test -f "$SCRATCH/state/backup-last-success" && echo "MARKER OK"
grep -c "rclone copyto" "$STUB_LOG" | grep -qx 2 && echo "RCLONE x2 OK"
grep -c "^age" "$STUB_LOG" | grep -qx 2 && echo "AGE x2 OK"
```

Expected output ends with:
```
backup ok: caliber-<today>.db.age + uploads-<today>.tar.gz.age -> r2:caliber-backups
MARKER OK
RCLONE x2 OK
AGE x2 OK
```

- [ ] **Step 4: Update DEPLOY.md.** In the "## Backup (ops floor before a second user)" section (lines 48-66), keep the "do not cp a live WAL DB" intro line, then replace the "**Nightly snapshot (floor).**" paragraph and its code block with:

````markdown
**Nightly off-box snapshot (the floor, scripted).** `scripts/backup.sh` (repo-tracked,
runs at `/opt/caliber/scripts/backup.sh`) does the whole pipeline: `VACUUM INTO`
(rm-first — VACUUM INTO refuses to overwrite) → tar the uploads volume →
`age -r <pubkey>` encrypt → `rclone` to R2, then writes the
`/root/.local/state/caliber/backup-last-success` marker that the alerting
check watches (>26h stale pages the operator). Cron on the host:

```
17 3 * * * /opt/caliber/scripts/backup.sh >> /var/log/caliber-backup.log 2>&1
```

Config in `/root/.config/caliber-backup.env` (NOT in git, NOT `.env.production`):
`AGE_RECIPIENT` (age public key) + `RCLONE_REMOTE` (R2 remote:bucket; creds in
rclone config). The age **private key lives in two places only**: the operator's
Mac and the password manager. `.env.production` is NOT automated — copy it to
the password manager manually whenever it changes.

**Restore drill (once, before invites, on the Mac):** `rclone copy` the latest
pair down → `age -d` both → boot an isolated stack
`docker compose -p caliber-restore-drill up` (distinct volumes — cannot touch
prod or dev) with the decrypted `caliber.db` + uploads dir mounted → log in,
open a real résumé → `docker compose -p caliber-restore-drill down -v`.
````

(Keep the existing litestream "Continuous (recommended for real users)" paragraph below it unchanged.)

- [ ] **Step 5: Commit.**

```bash
git add scripts/backup.sh DEPLOY.md
git commit -m "feat(ops): off-box encrypted backup script + runbook section"
```

---

### Task 8: Weekly usage SQL

**Wave:** 2 · **Tier:** Sonnet (low). SQL file, no vitest — verification runs the file against a schema-only DB built from the committed migrations.

**Files:**
- Create: `scripts/usage.sql`

**Interfaces:**
- Consumes: `job_scores` (`legitimacy` JSON `$.tier`, `verdict`, `cost_usd`, `user_id`), `url_checks.cost_usd`, `tailored_resumes.cost_usd` (nullable), `correlation_reports.cost_usd` (nullable), `application_answers.cost_usd`, `users`, `resumes`, `search_runs`, `applications` — all verified against `src/server/persistence/schema.ts` on current main.
- Produces: three `.mode box` reports run against an SSH'd **copy of the nightly snapshot**, never prod. Graduates to `/admin/usage` at ~50 users.

- [ ] **Step 1: Write the file.** Create `scripts/usage.sql`:

```sql
-- Caliber weekly usage report (pre-launch hardening Task 8 — cut to 3 queries;
-- the other five were n=20 noise per the Fable review).
--
-- RUN AGAINST A COPY of the nightly snapshot, NEVER prod:
--   scp box:/backups/caliber-<date>.db /tmp/caliber-usage.db   (or rclone + age -d)
--   sqlite3 /tmp/caliber-usage.db < scripts/usage.sql
--
-- Caveats (schema facts, not bugs):
-- * Timestamps are epoch MILLISECONDS → always /1000 before 'unixepoch'.
-- * job_scores upserts on rescan WITHOUT touching created_at, so any
--   cost-by-day cut of query 2 is lossy. Verdict/legitimacy distribution
--   (query 1) is correct — it wants latest-wins.
.mode box
.headers on

-- 1. Legitimacy/verdict distribution — the wedge-honesty check.
--    If ~99% lands in 'clear', the legitimacy wedge is decorative.
SELECT
  json_extract(legitimacy, '$.tier') AS legitimacy_tier,
  verdict,
  COUNT(*) AS n
FROM job_scores
GROUP BY legitimacy_tier, verdict
ORDER BY n DESC;

-- 2. Cost per user per feature (USD).
SELECT u.email, 'scoring' AS feature, ROUND(SUM(s.cost_usd), 4) AS usd
FROM job_scores s JOIN users u ON u.id = s.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'url-check', ROUND(SUM(c.cost_usd), 4)
FROM url_checks c JOIN users u ON u.id = c.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'tailor', ROUND(COALESCE(SUM(t.cost_usd), 0), 4)
FROM tailored_resumes t JOIN users u ON u.id = t.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'correlate', ROUND(COALESCE(SUM(r.cost_usd), 0), 4)
FROM correlation_reports r JOIN users u ON u.id = r.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'answers', ROUND(SUM(a.cost_usd), 4)
FROM application_answers a JOIN users u ON u.id = a.user_id GROUP BY u.email
ORDER BY email, usd DESC;

-- 3. Per-user activation funnel (registered → uploaded → scanned → scored →
--    tailored → tracked).
SELECT
  u.email,
  datetime(u.created_at / 1000, 'unixepoch') AS registered_utc,
  (SELECT COUNT(*) FROM resumes r WHERE r.user_id = u.id) AS resumes,
  (SELECT COUNT(*) FROM search_runs sr WHERE sr.user_id = u.id) AS scans,
  (SELECT COUNT(*) FROM job_scores js WHERE js.user_id = u.id) AS scored,
  (SELECT COUNT(*) FROM tailored_resumes t WHERE t.user_id = u.id) AS tailors,
  (SELECT COUNT(*) FROM applications a WHERE a.user_id = u.id) AS applications
FROM users u
ORDER BY u.created_at;
```

- [ ] **Step 2: Verify against a schema-only DB** (drizzle's `--> statement-breakpoint` lines start with `--`, so sqlite3 reads the migration files as-is):

```bash
TMP=$(mktemp -d)
cat drizzle/*.sql | sqlite3 "$TMP/usage-check.db"
sqlite3 "$TMP/usage-check.db" < scripts/usage.sql && echo "USAGE-SQL OK"
```

Expected: three (empty or seeded-admin-only) boxed tables print with headers, no SQL errors, then `USAGE-SQL OK`.

- [ ] **Step 3: Commit.**

```bash
git add scripts/usage.sql
git commit -m "feat(ops): weekly usage report SQL (verdict distribution, cost, funnel)"
```

---

### Task 1 (code slice, optional but recommended): `/api/health` db ping + `llmKeyConfigured`

**Wave:** 2 · **Tier:** Sonnet (low). The consolidation doc marks this "Optional code" under Task 1; it closes tracked risk 4 (`mode:'real'` with a blank key looks healthy). The container smoke + fresh-account browser legs are operator-only (see Operator runbook).

**Files:**
- Modify: `src/app/api/health/route.ts` (currently 7 lines: sync `GET` returning `{ ok, mode }`)
- Modify: `src/contract/registry.ts:116-130` (the `/api/health` response schema), regen `contract/openapi.json`
- Test: `src/app/api/health/route.test.ts` (create)

**Interfaces:**
- Consumes: `getDb()` (`@/server/persistence/db`), `testDoublesEnabled()` (`@/lib/llm/client`).
- Produces: `GET /api/health` → `{ ok: true, mode: "real"|"doubles", llmKeyConfigured: boolean }` or 503 `{ ok: false }`. Presence-only — a health check must NEVER spend a real LLM call. Task 3's on-box `curl -f` and UptimeRobot both consume this.

- [ ] **Step 1: Write the failing test.** Create `src/app/api/health/route.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ shouldFail: false }));
vi.mock("@/server/persistence/db", () => ({
  getDb: () => ({
    run: async () => {
      if (state.shouldFail) throw new Error("db gone");
      return { rowsAffected: 0 };
    },
  }),
}));

import { GET } from "./route";

const originalKey = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

beforeEach(() => {
  state.shouldFail = false;
  delete process.env.OPENROUTER_API_KEY;
});

describe("GET /api/health", () => {
  it("reports llmKeyConfigured: false when the key is absent", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, llmKeyConfigured: false });
  });

  it("reports llmKeyConfigured: true on key PRESENCE only — no LLM call", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const res = await GET();
    expect((await res.json()).llmKeyConfigured).toBe(true);
  });

  it("503s ok:false when the db ping throws", async () => {
    state.shouldFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/app/api/health/route.test.ts`
Expected: FAIL — `llmKeyConfigured` undefined; 503 test gets 200 (no db ping yet).

- [ ] **Step 3: Implement.** Replace `src/app/api/health/route.ts` with:

```ts
// GET /api/health — liveness for UptimeRobot + on-box alert-check.sh.
// `SELECT 1` proves the DB file is reachable; `llmKeyConfigured` is presence
// only (tracked risk 4: mode:'real' with a blank key looked healthy) — a
// health check must NEVER spend a real LLM call.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { testDoublesEnabled } from "@/lib/llm/client";
import { getDb } from "@/server/persistence/db";

export async function GET() {
  try {
    await getDb().run(sql`SELECT 1`);
  } catch (err) {
    console.error("health: db ping failed:", err);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    mode: testDoublesEnabled() ? "doubles" : "real",
    llmKeyConfigured: !!process.env.OPENROUTER_API_KEY,
  });
}
```

- [ ] **Step 4: Update the contract.** In `src/contract/registry.ts:125`, change the health 200 schema to:

```ts
          schema: z.object({ ok: z.boolean(), mode: z.enum(["real", "doubles"]), llmKeyConfigured: z.boolean() }),
```

Run: `npm run contract`

- [ ] **Step 5: Run + commit** (contract in the same commit):

Run: `npx vitest run src/app/api/health/route.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/app/api/health/ src/contract/registry.ts contract/openapi.json
git commit -m "feat(health): db ping + llmKeyConfigured presence flag"
```

---

### Task 9: SSRF residual-risk annotation (tracked risk 1 disposition)

**Wave:** 2 · **Tier:** Sonnet (low). Comment-only — no test cycle; `tsc` is the gate. The operator explicitly accepted the DNS-rebind residual for the friends launch; the file's own header currently contradicts that ("Hard blocker before any hosted deploy" — and the app has been hosted since 2026-07-16).

**Files:**
- Modify: `src/server/url-check/ssrf.ts:6-10` (header comment)

- [ ] **Step 1: Amend the comment.** Replace lines 6-10 of `src/server/url-check/ssrf.ts`:

Old:

```ts
// Residual risk (accepted for the local single-operator box, spec §7):
// this is a check-then-connect gap — a DNS answer can rebind between our
// lookup here and undici's own connect in fetch-page.ts. Closing that needs
// a custom undici Agent whose connect hook re-validates `socket.remoteAddress`
// per connection. Hard blocker before any hosted deploy.
```

New:

```ts
// Residual risk: this is a check-then-connect gap — a DNS answer can rebind
// between our lookup here and undici's own connect in fetch-page.ts. Closing
// that needs a custom undici Agent whose connect hook re-validates
// `socket.remoteAddress` per connection.
// DISPOSITION (pre-launch hardening 2026-07-17, tracked risk 1): explicitly
// ACCEPTED for the invite-only friends launch — exploiting the rebind window
// needs an authenticated user running a malicious DNS server, implausible at
// n≤20. The undici connect-hook re-validation GATES PUBLIC LAUNCH.
```

- [ ] **Step 2: Typecheck + commit.**

Run: `npm run typecheck`
Expected: green.

```bash
git add src/server/url-check/ssrf.ts
git commit -m "docs(ssrf): record accepted rebind residual for friends launch; gate public launch"
```

---

### Task 7: Verdict-wrong feedback link on JobDetail

**Wave:** 3 (needs Task 4's `support.ts`) · **Tier:** Sonnet (low–med).

**Files:**
- Create: `src/caliber-ui/lib/feedback.ts`
- Test: `src/caliber-ui/lib/feedback.test.ts`
- Modify: `src/caliber-ui/compositions/Detail/JobDetail.tsx` (quiet link after the actions row, line ~181)
- Test: extend `src/caliber-ui/compositions/Detail/JobDetail.dom.test.tsx`

**Interfaces:**
- Consumes: `Job` (`@/types` — `role`, `company`, `score`, `legitimacy.tier`, `id`, `applyUrl`); `OPERATOR_TELEGRAM_HANDLE` context from Task 4's `support.ts` (the share-URL flow itself needs no handle — the user picks the operator from their chat list — but the module doc references it).
- Produces: `buildVerdictFeedbackUrl(job: Job): string` → `https://t.me/share/url?url=<applyUrl>&text=<context>`. **JobDetail only** — feed rows / eval card funnel here anyway.

- [ ] **Step 1: Write the failing unit test.** Create `src/caliber-ui/lib/feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildVerdictFeedbackUrl } from "./feedback";
import { jobs } from "../fixtures";

describe("buildVerdictFeedbackUrl (Task 7, Decision 1)", () => {
  const job = jobs[0];
  const url = new URL(buildVerdictFeedbackUrl(job));

  it("targets the Telegram share endpoint (t.me/share/url prefills url + text)", () => {
    expect(url.origin + url.pathname).toBe("https://t.me/share/url");
  });

  it("carries the posting URL and a context block: title, company, tier, job id, lead-in", () => {
    expect(url.searchParams.get("url")).toBe(job.applyUrl);
    const text = url.searchParams.get("text") ?? "";
    expect(text).toContain(job.role);
    expect(text).toContain(job.company);
    expect(text).toContain(job.legitimacy.tier);
    expect(text).toContain(job.id);
    expect(text).toContain("What looks wrong:");
  });

  it("never includes the description (URL-length safe)", () => {
    expect((url.searchParams.get("text") ?? "").length).toBeLessThan(500);
  });
});
```

(`jobs` is the existing fixture barrel `src/caliber-ui/fixtures` — the same import `JobDetail.dom.test.tsx` uses as `../../fixtures`.)

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/caliber-ui/lib/feedback.test.ts`
Expected: FAIL — module `./feedback` not found.

- [ ] **Step 3: Implement.** Create `src/caliber-ui/lib/feedback.ts`:

```ts
// Verdict-wrong feedback link (pre-launch hardening Task 7, Decision 1 —
// Telegram). Telegram does NOT support prefilled text to a personal account
// (the wa.me-style ?text= capability was removed) — t.me/share/url prefills
// BOTH fields and the user taps once to pick the operator (see
// OPERATOR_TELEGRAM_HANDLE in ./support.ts) from their chat list. The text
// covers both fit and legitimacy; no description — URL-length safe.
// Graduates to a verdict_feedback table when reports get lost or at public
// launch.
import type { Job } from "../../types";

export function buildVerdictFeedbackUrl(job: Job): string {
  const context = [
    "Caliber verdict feedback",
    `Job: ${job.role} — ${job.company}`,
    `Fit: ${job.score.toFixed(1)}/5 · Legitimacy: ${job.legitimacy.tier}`,
    `Job id: ${job.id}`,
    "What looks wrong:",
  ].join("\n");
  return `https://t.me/share/url?url=${encodeURIComponent(job.applyUrl)}&text=${encodeURIComponent(context)}`;
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/caliber-ui/lib/feedback.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing DOM test.** Append to `src/caliber-ui/compositions/Detail/JobDetail.dom.test.tsx` (reuse the file's existing render-props helper if it has one; otherwise these are the minimal required props):

```tsx
it("renders the quiet verdict-feedback link (Task 7)", () => {
  render(
    <JobDetail
      job={jobs[0]}
      onApply={() => {}}
      onTailor={() => {}}
      onAnswerQuestions={() => {}}
      onMarkApplied={async () => {}}
    />,
  );
  const link = screen.getByRole("link", { name: /verdict look wrong/i });
  expect(link).toHaveAttribute("href", expect.stringContaining("https://t.me/share/url?"));
});
```

Run: `npx vitest run src/caliber-ui/compositions/Detail/JobDetail.dom.test.tsx`
Expected: FAIL — no such link.

- [ ] **Step 6: Wire the link into JobDetail.** In `JobDetail.tsx`: add the import

```tsx
import { buildVerdictFeedbackUrl } from "../../lib/feedback";
```

and after the actions-row `</div>` (the flex row closing after `<AppliedButton ... />`, line ~181), before the closing `</Card>`:

```tsx
      <div style={{ marginTop: 10 }}>
        <a
          href={buildVerdictFeedbackUrl(job)}
          target="_blank"
          rel="noreferrer"
          style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
        >
          Verdict look wrong? Tell the operator on Telegram
        </a>
      </div>
```

(A real `<a>` — the kit `Button` has no `href`; quiet register `--text-muted`, mirroring `AuthCard.tsx:74-78`'s quiet-link. NOT brand red, NOT danger tone — this is not a legitimacy signal.)

- [ ] **Step 7: Run + commit.**

Run: `npx vitest run src/caliber-ui/lib/feedback.test.ts src/caliber-ui/compositions/Detail/JobDetail.dom.test.tsx && npm run typecheck`
Expected: PASS.

```bash
git add src/caliber-ui/lib/feedback.ts src/caliber-ui/lib/feedback.test.ts src/caliber-ui/compositions/Detail/JobDetail.tsx src/caliber-ui/compositions/Detail/JobDetail.dom.test.tsx
git commit -m "feat(feedback): verdict-wrong Telegram share link on JobDetail"
```

---

### Task 5: PDPA pack — consent caption + delete-user runbook script

**Wave:** 3 · **Tier:** Sonnet (med) — the 13-table order is fully specified; do not reorder it.

**Files:**
- Modify: `src/caliber-ui/compositions/Auth/AuthCard.tsx` (optional `footnote` prop)
- Test: extend `src/caliber-ui/compositions/Auth/AuthCard.dom.test.tsx`
- Modify: `src/app/(auth)/register/page.tsx` (pass the caption)
- Create: `src/server/persistence/delete-user.ts`
- Test: `src/server/persistence/delete-user.test.ts`
- Modify: `package.json` (add `user:delete` script — first toucher; Task 6 adds its script after)

**Interfaces:**
- Consumes: `uploadsRoot()` (`src/server/resume/uploads.ts:8` — throws when `CALIBER_UPLOADS_DIR` unset, fail-loud); fixtures helpers (`insertSource/insertResume/insertJob/insertJobScore` accept `userId` overrides); `seed.ts`'s CLI-entry idiom (`process.argv[1] === fileURLToPath(import.meta.url)` + explicit `process.exit` — libsql keeps the process alive otherwise).
- Produces: `AuthCardProps.footnote?: React.ReactNode`; `countUserRows(db, userId): Promise<Record<string, number>>`; `deleteUser(db, userId): Promise<void>` — 13-table FK-safe order, dry-run default via the CLI, `--confirm` to mutate, re-runnable.

- [ ] **Step 1: Failing caption test.** Append to `src/caliber-ui/compositions/Auth/AuthCard.dom.test.tsx` (mirror its existing render idiom):

```tsx
it("renders the register consent footnote when provided (Task 5, PDPA-aware)", () => {
  render(
    <AuthCard
      mode="register"
      onSubmit={() => {}}
      busy={false}
      switchHref="/login"
      switchLabel="Sign in instead"
      footnote="consent caption here"
    />,
  );
  expect(screen.getByText("consent caption here")).toBeInTheDocument();
});
```

Run: `npx vitest run src/caliber-ui/compositions/Auth/AuthCard.dom.test.tsx`
Expected: FAIL — `footnote` is not a prop / not rendered.

- [ ] **Step 2: Implement the prop.** In `AuthCard.tsx`: add to `AuthCardProps` (after `extraFields?: React.ReactNode;`):

```tsx
  /** Quiet caption under the switch link — the register page's PDPA consent
   * line (pre-launch hardening Task 5). Same --type-caption/--text-muted
   * register as the switch link above it. */
  footnote?: React.ReactNode;
```

Destructure `footnote` in the function signature, and render after the switch-link `<div>` (line ~78), inside the column flex:

```tsx
        {footnote && (
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", textAlign: "center" }}>
            {footnote}
          </div>
        )}
```

- [ ] **Step 3: Pass the caption from the register page.** In `src/app/(auth)/register/page.tsx`, add to the `<AuthCard ...>` props (after `extraFields={...}`):

```tsx
      footnote="By creating an account you agree that Caliber stores your résumé, job matches, and application history to run matching and legitimacy checks. Message the operator any time to have your account and all data deleted."
```

(Deliberately "PDPA-aware, best-effort" wording — never claims "PDPA-compliant". The full consent paragraph lives in the WhatsApp/Telegram invite — operator runbook step 10.)

- [ ] **Step 4: Run + commit part A.**

Run: `npx vitest run src/caliber-ui/compositions/Auth/AuthCard.dom.test.tsx && npm run typecheck`
Expected: PASS.

```bash
git add src/caliber-ui/compositions/Auth/AuthCard.tsx src/caliber-ui/compositions/Auth/AuthCard.dom.test.tsx "src/app/(auth)/register/page.tsx"
git commit -m "feat(pdpa): register consent caption via AuthCard footnote"
```

- [ ] **Step 5: Failing delete-user test.** Create `src/server/persistence/delete-user.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./test-db";
import { countUserRows, deleteUser } from "./delete-user";
import {
  applicationAnswers,
  applications,
  correlationReports,
  creditLedger,
  profile,
  searchRuns,
  sessions,
  tailoredResumes,
  urlChecks,
  users,
} from "./schema";
import { insertJob, insertJobScore, insertResume, insertSource } from "./repos/__fixtures__/helpers";

async function seedFullGraph(db: TestDb, userId: string, suffix: string) {
  const source = await insertSource(db);
  const resume = await insertResume(db, { userId, isActive: true });
  const job = await insertJob(db, source.id, { userId });
  await insertJobScore(db, job.id, resume.id, { userId });
  await db.insert(sessions).values({ userId, tokenHash: `tok-${suffix}` });
  await db.insert(profile).values({
    id: `profile-${suffix}`,
    userId,
    baseCountry: "MY",
    relocation: "stay",
    scheduleFlex: "any-hours",
    employmentPref: "any",
  });
  await db.insert(searchRuns).values({
    userId,
    resumeId: resume.id,
    personas: ["remote"],
    status: "completed",
    stats: { scanned: 1, matched: 1, scored: 1, worth: 1, ghosts: 0, perSource: [] },
  });
  const [report] = await db
    .insert(correlationReports)
    .values({ userId, jobId: job.id, resumeId: resume.id, rows: [], status: "completed", model: "test-model" })
    .returning();
  const [tailored] = await db
    .insert(tailoredResumes)
    .values({
      userId,
      jobId: job.id,
      baseResumeId: resume.id,
      reportId: report.id,
      diff: [],
      status: "completed",
      model: "test-model",
    })
    .returning();
  const [answers] = await db
    .insert(applicationAnswers)
    .values({ userId, jobId: job.id, resumeId: resume.id, formSource: "pasted", answers: [], model: "test-model", costUsd: 0 })
    .returning();
  await db.insert(applications).values({
    userId,
    jobId: job.id,
    resumeId: resume.id,
    tailoredResumeId: tailored.id,
    answersId: answers.id,
    stage: 0,
    statusLabel: "Applied",
    statusTone: "good",
    note: "",
  });
  await db.insert(creditLedger).values({ userId, delta: 30, reason: "signup" });
  await db.insert(urlChecks).values({
    userId,
    url: `https://example.com/check-${suffix}`,
    dedupeKey: `check-${suffix}`,
    status: "completed",
    alreadyKnown: false,
    needsText: false,
    costUsd: 0,
    raw: {},
  });
}

describe("deleteUser (Task 5 — 13-table FK-safe delete)", () => {
  let db: TestDb;
  let uploads: string;

  beforeEach(async () => {
    db = await createTestDb();
    uploads = mkdtempSync(join(tmpdir(), "caliber-uploads-"));
    process.env.CALIBER_UPLOADS_DIR = uploads;
  });

  afterEach(() => {
    delete process.env.CALIBER_UPLOADS_DIR;
  });

  it("removes every row across all 13 tables + the uploads dir; the second user is untouched", async () => {
    const [userA] = await db
      .insert(users)
      .values({ email: "a@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const [userB] = await db
      .insert(users)
      .values({ email: "b@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await seedFullGraph(db, userA.id, "a");
    await seedFullGraph(db, userB.id, "b");
    mkdirSync(join(uploads, userA.id), { recursive: true });
    writeFileSync(join(uploads, userA.id, "resume.pdf"), "pdf");
    mkdirSync(join(uploads, userB.id), { recursive: true });

    const before = await countUserRows(db, userA.id);
    expect(Object.keys(before)).toHaveLength(13);
    expect(Object.values(before).every((n) => n >= 1)).toBe(true); // full graph seeded

    await deleteUser(db, userA.id);

    const after = await countUserRows(db, userA.id);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    expect(existsSync(join(uploads, userA.id))).toBe(false);

    const bAfter = await countUserRows(db, userB.id);
    expect(Object.values(bAfter).every((n) => n >= 1)).toBe(true);
    expect(existsSync(join(uploads, userB.id))).toBe(true);
  });

  it("re-runs cleanly (idempotent — every delete is a no-op the second time)", async () => {
    const [userA] = await db
      .insert(users)
      .values({ email: "rerun@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await deleteUser(db, userA.id);
    await expect(deleteUser(db, userA.id)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run to verify failure.**

Run: `npx vitest run src/server/persistence/delete-user.test.ts`
Expected: FAIL — `./delete-user` not found.

- [ ] **Step 7: Implement.** Create `src/server/persistence/delete-user.ts`:

```ts
// PDPA delete-user runbook (pre-launch hardening Task 5). Dry-run by default;
// `--confirm` mutates. Deletes one user's entire graph in the 13-table
// FK-safe order, then removes their uploads directory.
//
// Ordered single idempotent statements, NEVER db.transaction() (global
// constraint — the libsql file: driver corrupts under concurrency). A crash
// mid-sequence re-runs cleanly: every delete is a no-op the second time and
// the `users` row goes last, so the CLI email lookup still resolves.
//
// Usage (locally; on the box prefix with `docker compose run --rm app`):
//   npm run user:delete -- someone@example.com            # dry-run: counts only
//   npm run user:delete -- someone@example.com --confirm  # deletes
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "./db";
import {
  applicationAnswers,
  applications,
  correlationReports,
  creditLedger,
  jobScores,
  jobs,
  profile,
  resumes,
  searchRuns,
  sessions,
  tailoredResumes,
  urlChecks,
  users,
} from "./schema";
import type { Db } from "./repos/db";
import { uploadsRoot } from "@/server/resume/uploads";

// FK-safe order (consolidation doc Task 5 — the original 12 + credit_ledger):
// dependents before their targets — applications before tailored_resumes/
// application_answers (applications FKs both), tailored_resumes before
// correlation_reports (report_id FK), every job dependent before jobs,
// search_runs/job_scores before resumes, profile before users. `sources` is
// global — never deleted.
const TABLES: { name: string; table: SQLiteTable; userCol: AnySQLiteColumn }[] = [
  { name: "sessions", table: sessions, userCol: sessions.userId },
  { name: "applications", table: applications, userCol: applications.userId },
  { name: "tailored_resumes", table: tailoredResumes, userCol: tailoredResumes.userId },
  { name: "application_answers", table: applicationAnswers, userCol: applicationAnswers.userId },
  { name: "correlation_reports", table: correlationReports, userCol: correlationReports.userId },
  { name: "job_scores", table: jobScores, userCol: jobScores.userId },
  { name: "credit_ledger", table: creditLedger, userCol: creditLedger.userId },
  { name: "url_checks", table: urlChecks, userCol: urlChecks.userId },
  { name: "search_runs", table: searchRuns, userCol: searchRuns.userId },
  { name: "jobs", table: jobs, userCol: jobs.userId },
  { name: "resumes", table: resumes, userCol: resumes.userId },
  { name: "profile", table: profile, userCol: profile.userId },
  { name: "users", table: users, userCol: users.id },
];

export async function countUserRows(db: Db, userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const [row] = await db.select({ n: count() }).from(t.table).where(eq(t.userCol, userId));
    counts[t.name] = row.n;
  }
  return counts;
}

export async function deleteUser(db: Db, userId: string): Promise<void> {
  for (const t of TABLES) {
    await db.delete(t.table).where(eq(t.userCol, userId));
  }
  await rm(join(uploadsRoot(), userId), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [emailArg, confirmFlag] = process.argv.slice(2);
  if (!emailArg) throw new Error("Usage: npm run user:delete -- <email> [--confirm]");
  const confirm = confirmFlag === "--confirm";
  const db = getDb();
  (async () => {
    const [user] = await db.select().from(users).where(eq(users.email, emailArg.trim().toLowerCase()));
    if (!user) throw new Error(`No user with email ${emailArg}`);
    const counts = await countUserRows(db, user.id);
    console.log(`user ${user.email} (${user.id}) — rows per table:`, counts);
    if (!confirm) {
      console.log("Dry-run only. Re-run with --confirm to delete.");
      process.exit(0);
    }
    await deleteUser(db, user.id);
    console.log(`Deleted ${user.email} and uploads dir ${join(uploadsRoot(), user.id)}.`);
    process.exit(0); // libsql keeps the process alive otherwise (seed.ts idiom)
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 8: Add the npm script.** In `package.json` scripts (after `"db:seed:test"`, mirroring `db:seed`'s env-file idiom):

```json
    "user:delete": "tsx --env-file-if-exists=.env.local src/server/persistence/delete-user.ts",
```

(On the box, env comes from the compose `env_file`; locally pass `DATABASE_URL`/`CALIBER_UPLOADS_DIR` inline if `.env.local` is absent — same gotcha as `db:migrate`.)

- [ ] **Step 9: Run + commit part B.**

Run: `npx vitest run src/server/persistence/delete-user.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/server/persistence/delete-user.ts src/server/persistence/delete-user.test.ts package.json
git commit -m "feat(pdpa): 13-table delete-user runbook script (dry-run default)"
```

---

### Task 6: Password reset script + self-serve change-password

**Wave:** 4 (after Task 4 — `src/types`/registry serialization; after Task 5 — `package.json`) · **Tier:** Sonnet (med–high) — the session-kill/re-mint ordering needs care; everything is specified.

**Files:**
- Modify: `src/server/persistence/repos/users.ts` (add `updatePasswordHash`; extend the lazy `usersRepo` export)
- Modify: `src/server/persistence/repos/sessions.ts` (add `deleteAllByUserId`; extend the lazy `sessionsRepo` export)
- Tests: extend `src/server/persistence/repos/users.test.ts`, `src/server/persistence/repos/sessions.test.ts`
- Create: `src/server/auth/reset-password.ts` + `src/server/auth/reset-password.test.ts`
- Modify: `package.json` (add `auth:reset-password`)
- Modify: `src/types/index.ts` (`ChangePasswordRequest` after `LoginRequest`, line 463)
- Create: `src/app/api/auth/password/route.ts` (PATCH)
- Test: extend `src/app/api/auth/auth.route.test.ts`
- Create: `src/caliber-ui/compositions/Profile/ChangePasswordCard.tsx` + `ChangePasswordCard.dom.test.tsx`
- Modify: `src/features/auth/client.ts` (`changePassword`)
- Modify: `src/app/(app)/profile/page.tsx` (mount the card)
- Modify: `src/contract/registry.ts` + regen `contract/openapi.json`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` (`src/server/auth/password.ts`), `mintSessionToken` (`token.ts`), `requireUser`/`sessionCookieOptions` (`session.ts`), `UnauthorizedError` (`errors.ts`), `SessionResponse` (existing response schema — reused by the PATCH).
- Produces: `usersRepo.updatePasswordHash(id: string, passwordHash: string): Promise<void>` (throws on unknown id); `sessionsRepo.deleteAllByUserId(userId: string): Promise<void>`; `generatePassword(length?: number): string`; `ChangePasswordRequest`; `PATCH /api/auth/password` → 200 `SessionResponse` + fresh cookie / 401 / 422; `changePassword(input: ChangePasswordRequest): Promise<AuthUser>`.

- [ ] **Step 1: Failing repo tests.**

Append to `src/server/persistence/repos/users.test.ts` (reuse its existing `createTestDb`/`createUserRepo` imports):

```ts
it("updatePasswordHash swaps the hash; unknown id throws (fail loud)", async () => {
  const db = await createTestDb();
  const repo = createUserRepo(db);
  const u = await repo.create({ email: "pw@x.co", passwordHash: "old-hash", role: "user" });
  await repo.updatePasswordHash(u.id, "new-hash");
  expect((await repo.findById(u.id))?.passwordHash).toBe("new-hash");
  await expect(repo.updatePasswordHash("nope", "h")).rejects.toThrow("updatePasswordHash: unknown user nope");
});
```

Append to `src/server/persistence/repos/sessions.test.ts` (add `users` to its schema import and `createUserRepo` if absent — or seed users via direct insert as below, matching the file's style):

```ts
it("deleteAllByUserId kills every session for that user and nobody else's", async () => {
  const db = await createTestDb();
  const [a] = await db
    .insert(users)
    .values({ email: "sa@x.co", passwordHash: "h", role: "user", plan: "standard" })
    .returning();
  const [b] = await db
    .insert(users)
    .values({ email: "sb@x.co", passwordHash: "h", role: "user", plan: "standard" })
    .returning();
  const repo = createSessionRepo(db);
  await repo.create({ userId: a.id, tokenHash: "a1" });
  await repo.create({ userId: a.id, tokenHash: "a2" });
  await repo.create({ userId: b.id, tokenHash: "b1" });

  await repo.deleteAllByUserId(a.id);

  expect(await repo.findUserByTokenHash("a1")).toBeNull();
  expect(await repo.findUserByTokenHash("a2")).toBeNull();
  expect((await repo.findUserByTokenHash("b1"))?.id).toBe(b.id);
});
```

Run: `npx vitest run src/server/persistence/repos/users.test.ts src/server/persistence/repos/sessions.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 2: Implement the repo methods.**

`users.ts` — add after `updatePlan` inside `createUserRepo`, and mirror into the lazy `usersRepo` export at the bottom:

```ts
    // GLOBAL-BY-DECISION: `id` IS the users.id primary key (same dimension
    // as findById). Shared by the operator reset script and the self-serve
    // change-password route (Task 6).
    async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
      const [row] = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
      if (!row) throw new Error(`updatePasswordHash: unknown user ${id}`);
    },
```

```ts
  updatePasswordHash: (id, hash) => createUserRepo(getDb()).updatePasswordHash(id, hash),
```

`sessions.ts` — add after `deleteByTokenHash` inside `createSessionRepo`, and mirror into the lazy export:

```ts
    // GLOBAL-BY-DECISION: password reset / change kills every session for
    // the target user (Task 6) — the caller supplies the userId from an
    // already-authorized context (operator CLI or a reverified session).
    async deleteAllByUserId(userId: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.userId, userId));
    },
```

```ts
  deleteAllByUserId: (u) => createSessionRepo(getDb()).deleteAllByUserId(u),
```

Run: `npx vitest run src/server/persistence/repos/users.test.ts src/server/persistence/repos/sessions.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit the repo slice.**

```bash
git add src/server/persistence/repos/users.ts src/server/persistence/repos/users.test.ts src/server/persistence/repos/sessions.ts src/server/persistence/repos/sessions.test.ts
git commit -m "feat(auth): updatePasswordHash + deleteAllByUserId repo methods"
```

- [ ] **Step 4: Failing generator test.** Create `src/server/auth/reset-password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generatePassword } from "./reset-password";

describe("generatePassword (Task 6 reset script)", () => {
  it("emits 12 typeable chars from the unambiguous alphabet (no 0/O/1/l/I)", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
  });

  it("two invocations differ (not a fixed string)", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
```

Run: `npx vitest run src/server/auth/reset-password.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the reset script.** Create `src/server/auth/reset-password.ts`:

```ts
// Operator password-reset runbook (pre-launch hardening Task 6, Decision 2).
// GENERATES a password and prints it once — never accepts one via argv (a
// shared-box shell history would leak it). Two-invocation flow: dry-run by
// default, `--confirm` mutates and kills every session for the user.
//
// Usage (locally; on the box prefix with `docker compose run --rm app`):
//   npm run auth:reset-password -- someone@example.com            # dry-run
//   npm run auth:reset-password -- someone@example.com --confirm  # resets
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/server/persistence/db";
import { sessions, users } from "@/server/persistence/schema";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword } from "./password";

// Typeable + unambiguous: no 0/O, 1/l/I. 12 chars of 54 ≈ 69 bits.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [emailArg, confirmFlag] = process.argv.slice(2);
  if (!emailArg) throw new Error("Usage: npm run auth:reset-password -- <email> [--confirm]");
  const confirm = confirmFlag === "--confirm";
  const db = getDb();
  (async () => {
    const [user] = await db.select().from(users).where(eq(users.email, emailArg.trim().toLowerCase()));
    if (!user) throw new Error(`No user with email ${emailArg}`);
    const [{ n }] = await db.select({ n: count() }).from(sessions).where(eq(sessions.userId, user.id));
    console.log(`user ${user.email} (${user.id}) — ${n} live session(s) will be killed.`);
    if (!confirm) {
      console.log("Dry-run only. Re-run with --confirm to reset the password.");
      process.exit(0);
    }
    const password = generatePassword();
    await usersRepo.updatePasswordHash(user.id, await hashPassword(password));
    await sessionsRepo.deleteAllByUserId(user.id);
    console.log(`New password for ${user.email}: ${password}`);
    console.log("All sessions killed. Share over a private channel; the user should change it on /profile.");
    process.exit(0); // libsql keeps the process alive otherwise (seed.ts idiom)
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Add to `package.json` scripts (directly after the `user:delete` line Task 5 added):

```json
    "auth:reset-password": "tsx --env-file-if-exists=.env.local src/server/auth/reset-password.ts",
```

Run: `npx vitest run src/server/auth/reset-password.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the reset script.**

```bash
git add src/server/auth/reset-password.ts src/server/auth/reset-password.test.ts package.json
git commit -m "feat(auth): operator reset-password script (generated password, session kill)"
```

- [ ] **Step 7: Failing route tests.** In `src/app/api/auth/auth.route.test.ts`:

Extend the hoisted mocks (line 4-8) — `usersRepo` gains `findById: vi.fn(), updatePasswordHash: vi.fn()`; `sessionsRepo` gains `deleteAllByUserId: vi.fn()`. Replace the `@/server/auth/session` partial mock (lines 13-16) with one that also overrides `requireUser` (the real `requireUser` closes over the module-local `getSession`, so mocking `getSession` alone doesn't reach it):

```ts
vi.mock("@/server/auth/session", async (orig) => {
  const actual = await orig<typeof import("@/server/auth/session")>();
  return {
    ...actual,
    getSession: () => getSession(),
    requireUser: async () => {
      const user = await getSession();
      if (!user) {
        const { UnauthorizedError } = await import("@/server/auth/errors");
        throw new UnauthorizedError();
      }
      return user;
    },
  };
});
```

Add the import `import { PATCH as changePassword } from "./password/route";` and the describe block:

```ts
describe("PATCH /api/auth/password", () => {
  function patchRequest(body: unknown): Request {
    return new Request("http://x/api/auth/password", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("changes the password, kills all sessions, mints a fresh one", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    usersRepo.findById.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      role: "user",
      passwordHash: await hashPassword("old-password"),
    });
    const res = await changePassword(patchRequest({ currentPassword: "old-password", newPassword: "brand-new-pass" }));
    expect(res.status).toBe(200);
    expect(usersRepo.updatePasswordHash).toHaveBeenCalledWith("u1", expect.not.stringContaining("brand-new-pass"));
    expect(sessionsRepo.deleteAllByUserId).toHaveBeenCalledWith("u1");
    expect(sessionsRepo.create).toHaveBeenCalledOnce();
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("caliber_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("401s on a wrong current password without touching hash or sessions", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    usersRepo.findById.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      role: "user",
      passwordHash: await hashPassword("old-password"),
    });
    const res = await changePassword(patchRequest({ currentPassword: "wrong", newPassword: "brand-new-pass" }));
    expect(res.status).toBe(401);
    expect(usersRepo.updatePasswordHash).not.toHaveBeenCalled();
    expect(sessionsRepo.deleteAllByUserId).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await changePassword(patchRequest({ currentPassword: "x", newPassword: "brand-new-pass" }));
    expect(res.status).toBe(401);
  });

  it("422s a too-short new password", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    const res = await changePassword(patchRequest({ currentPassword: "old-password", newPassword: "short" }));
    expect(res.status).toBe(422);
  });
});
```

Run: `npx vitest run src/app/api/auth/auth.route.test.ts`
Expected: the new describe FAILS (route missing); every pre-existing auth test still PASSES (the widened session mock is behaviour-identical for them).

- [ ] **Step 8: Implement the contract type + route.**

`src/types/index.ts` — insert after `LoginRequest` (line 463):

```ts
// ChangePasswordRequest — PATCH /api/auth/password body (Task 6, Decision 2).
// The route reverifies currentPassword server-side before rehashing.
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
```

Create `src/app/api/auth/password/route.ts`:

```ts
// PATCH /api/auth/password — self-serve change-password (Task 6, Decision 2).
// Reverifies the CURRENT password, rehashes, then kills EVERY session for the
// user (a leaked session must not survive a password change) and mints a
// fresh one so the caller stays signed in. Shares updatePasswordHash +
// deleteAllByUserId with the operator reset script.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ChangePasswordRequest, AuthUser, type ErrorEnvelope } from "@/types";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { mintSessionToken } from "@/server/auth/token";
import { requireUser, sessionCookieOptions } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/auth/errors";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

export async function PATCH(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }
  try {
    const session = await requireUser();
    const { currentPassword, newPassword } = ChangePasswordRequest.parse(json);
    const user = await usersRepo.findById(session.id);
    if (!user) throw new Error(`change-password: session user ${session.id} has no users row`);
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      return errorResponse(401, "UNAUTHORIZED", "Current password is incorrect.");
    }
    await usersRepo.updatePasswordHash(user.id, await hashPassword(newPassword));
    await sessionsRepo.deleteAllByUserId(user.id);
    const { raw, hash } = mintSessionToken();
    await sessionsRepo.create({ userId: user.id, tokenHash: hash });
    const res = NextResponse.json({ user: AuthUser.parse(user) }, { status: 200 });
    res.cookies.set(sessionCookieOptions(raw));
    return res;
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid change-password body.", err.issues);
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
```

Run: `npx vitest run src/app/api/auth/auth.route.test.ts`
Expected: PASS (all, new + old).

- [ ] **Step 9: Register the path + regen.** In `src/contract/registry.ts`: add `ChangePasswordRequest` to the `@/types` import and `entitySchemas`; append after the `/api/auth/session` block:

```ts
registry.registerPath({
  method: "patch",
  path: "/api/auth/password",
  summary: "Self-serve change-password — reverifies current password, kills other sessions, re-mints the caller's",
  request: { body: { content: { "application/json": { schema: ChangePasswordRequest } } } },
  responses: {
    200: { description: "Password changed; fresh session cookie set", content: { "application/json": { schema: SessionResponse } } },
    401: { description: "No session, or wrong current password", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});
```

Run: `npm run contract`

- [ ] **Step 10: Commit the route slice** (types + contract same commit):

```bash
git add src/types/index.ts src/app/api/auth/password/ src/app/api/auth/auth.route.test.ts src/contract/registry.ts contract/openapi.json
git commit -m "feat(auth): PATCH /api/auth/password self-serve change-password"
```

- [ ] **Step 11: Failing composition test.** Create `src/caliber-ui/compositions/Profile/ChangePasswordCard.dom.test.tsx` (if `getByLabelText` doesn't resolve because the kit `Input` doesn't associate its label, switch these queries to the idiom `AuthCard.dom.test.tsx` already uses — do not change the component to suit the test):

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordCard } from "./ChangePasswordCard";

afterEach(cleanup);

describe("ChangePasswordCard (Task 6)", () => {
  it("submits current + new password when both are valid", () => {
    const onSubmit = vi.fn();
    render(<ChangePasswordCard onSubmit={onSubmit} busy={false} />);
    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "brand-new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(onSubmit).toHaveBeenCalledWith("old-password", "brand-new-pass");
  });

  it("keeps the button disabled while the new password is under 8 chars", () => {
    render(<ChangePasswordCard onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "short" } });
    expect(screen.getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("shows the success line after a change", () => {
    render(<ChangePasswordCard onSubmit={() => {}} busy={false} success />);
    expect(screen.getByText(/other signed-in sessions were logged out/i)).toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/caliber-ui/compositions/Profile/ChangePasswordCard.dom.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 12: Implement the card, client fn, and page wiring.**

`src/caliber-ui/compositions/Profile/ChangePasswordCard.tsx`:

```tsx
"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { Input } from "../../components/Input";

export interface ChangePasswordCardProps {
  onSubmit(currentPassword: string, newPassword: string): void;
  busy: boolean;
  error?: string;
  success?: boolean;
}

// ChangePasswordCard — profile-page self-serve password change (Task 6,
// Decision 2). Mirrors AuthCard's controlled-Card idiom (kit Button is always
// type="button"; submit on click or Enter).
export function ChangePasswordCard({ onSubmit, busy, error, success }: ChangePasswordCardProps) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");

  function submit() {
    if (!current || next.length < 8 || busy) return;
    onSubmit(current, next);
  }

  return (
    <Card padding="lg" radius="lg" elevation="sm" style={{ maxWidth: 420, marginTop: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Change password</div>
        <Input
          label="Current password"
          type="password"
          value={current}
          disabled={busy}
          onChange={(e) => setCurrent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Input
          label="New password (min 8 characters)"
          type="password"
          value={next}
          disabled={busy}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && (
          <div
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--type-caption)", color: "var(--danger-ink)" }}
          >
            <Icon name="triangle-alert" size={14} />
            {error}
          </div>
        )}
        {success && (
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            Password changed. Other signed-in sessions were logged out.
          </div>
        )}
        <Button variant="primary" onClick={submit} disabled={busy || !current || next.length < 8}>
          {busy ? "Please wait…" : "Change password"}
        </Button>
      </div>
    </Card>
  );
}
```

`src/features/auth/client.ts` — add `ChangePasswordRequest` to the `@/types` import and append:

```ts
export async function changePassword(input: ChangePasswordRequest): Promise<AuthUser> {
  const { user } = await requestJson(
    "/api/auth/password",
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    SessionResponse,
  );
  return user;
}
```

`src/app/(app)/profile/page.tsx` — add the imports:

```tsx
import { ChangePasswordCard } from "@/caliber-ui/compositions/Profile/ChangePasswordCard";
import { changePassword } from "@/features/auth/client";
```

state + handler inside `ProfilePage` (next to the existing busy/error state):

```tsx
  const [pwBusy, setPwBusy] = React.useState(false);
  const [pwError, setPwError] = React.useState<string | undefined>();
  const [pwSuccess, setPwSuccess] = React.useState(false);

  async function handleChangePassword(currentPassword: string, newPassword: string) {
    setPwBusy(true);
    setPwError(undefined);
    setPwSuccess(false);
    try {
      await changePassword({ currentPassword, newPassword });
      setPwSuccess(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setPwBusy(false);
    }
  }
```

and render, directly after the `{profile && (<ProfileTargets ... />)}` block inside the same content `<div>`:

```tsx
        <ChangePasswordCard
          onSubmit={(current, next) => void handleChangePassword(current, next)}
          busy={pwBusy}
          error={pwError}
          success={pwSuccess}
        />
```

- [ ] **Step 13: Run everything + commit.**

Run: `npx vitest run src/caliber-ui/compositions/Profile src/app/api/auth/auth.route.test.ts src/features && npm run typecheck`
Expected: PASS.

```bash
git add src/caliber-ui/compositions/Profile/ChangePasswordCard.tsx src/caliber-ui/compositions/Profile/ChangePasswordCard.dom.test.tsx src/features/auth/client.ts "src/app/(app)/profile/page.tsx"
git commit -m "feat(auth): profile-page change-password form"
```

---

### Task 3 (repo slice): Tiered alert-check script + runbook section

**Wave:** 5 (after Task 2's DEPLOY.md section and Task 4's `[client-error]` literal exist) · **Tier:** Sonnet (med–high) — the classifier tiers encode judgment; the literals below are grounded against current main, do not improvise new ones. The UptimeRobot + BotFather setup is operator-only (see Operator runbook).

**Files:**
- Create: `scripts/alert-check.sh`
- Modify: `DEPLOY.md` (append an "## Alerting" section after the Backup section)

**Interfaces:**
- Consumes: `/root/.config/caliber-alert.env` (operator-created: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — box-only, never in git, never in `.env.production`); Task 2's `/root/.local/state/caliber/backup-last-success` marker; `GET /api/health` on-box; `docker compose logs app`. Requires bash ≥ 4.4 (empty-array expansion under `set -u`) — the box's bash 5 qualifies.
- Produces: one summary-only Telegram push per run (count-then-push-once; NEVER raw log lines to a third-party service — Telegram included).

**Grounded log literals (verified on current main — the classifier's whole value):**
- Page-on-first (crash / cost-cap / worker-loop): `crashed unexpectedly` (`search/run.ts:187`, `tailor/index.ts:178`), `failed to persist 'failed'` (`search/run.ts:193`, `tailor/index.ts:183`, `tailor/correlate.ts:207`), `correlate run .* crashed:` (`correlate.ts:204`), `daily cost cap reached` (`search/run.ts:591`), `url-check worker: drain loop error` (`worker.ts:147`), `url-check worker: drain slot crashed` (`worker.ts:141`), `url-check admission: kick failed` (`run.ts:370`).
- Page-above-threshold (routine flakes): `connector ".*" failed:` (`run.ts:325`), `scoring job .* failed:` (`run.ts:690`), `detail fetch for job .* failed:` (`run.ts:647`), `pipeline failed:` (`url-check/run.ts:304`), `processRow crashed for row` (`worker.ts:119`), `url-check worker: sweep failed` (`worker.ts:170`), `detail fetch failed:` (`score/evaluate.ts:31`), `evaluate failed:` (`api/jobs/[id]/evaluate/route.ts:46`), `failed to persist partial stats` (`run.ts:404`), `\[client-error\]` (Task 4's beacon).
- NEVER pages (allowlist matching excludes it by construction): the DESIGNED tier-escalation fallback `tier-1 extract-gate threw, escalating to tier 2` at `url-check/run.ts:203` — the naive `grep -i error` trap the consolidation doc warns about.
- The remaining ~8 `console.error` sites live in one-off CLI scripts (`seed.ts`, `migrate-uploads.ts`, `recompute-eligibility.ts`, …) that never reach `docker compose logs app` — deliberately unclassified.

- [ ] **Step 1: Write the script.** Create `scripts/alert-check.sh` (then `chmod +x`):

```bash
#!/usr/bin/env bash
# Caliber tiered alert check (pre-launch hardening Task 3, first-week slice).
# Repo-tracked → /opt/caliber/scripts/alert-check.sh. Cron (operator runbook):
#   */10 * * * * /opt/caliber/scripts/alert-check.sh >> /var/log/caliber-alert.log 2>&1
#
# Transport: Telegram bot (Decision 1). Config /root/.config/caliber-alert.env
# (box-only, never in git, never in .env.production):
#   TELEGRAM_BOT_TOKEN=123:abc
#   TELEGRAM_CHAT_ID=123456789
#
# Classifier contract (consolidation doc Task 3):
# - PAGE-ON-FIRST: crash / cost-cap / worker-loop literals — one hit pages.
# - PAGE-ABOVE-THRESHOLD: routine connector/scoring/url-check flakes — pages
#   only at >= THRESHOLD total hits in the window.
# - The DESIGNED tier-escalation fallback at src/server/url-check/run.ts:203
#   ("tier-1 extract-gate threw, escalating to tier 2") matches NEITHER list —
#   allowlist matching means it can never page (the naive `grep -i error` trap).
# - COUNT-THEN-PUSH-ONCE: one summary message per run, pattern counts only —
#   NEVER raw log lines to a third-party service (Telegram included).
#
# CALIBER_ALERT_* overrides are test seams; production uses the defaults.
# Requires bash >= 4.4 (empty-array expansion under set -u).
set -euo pipefail

CONF="${CALIBER_ALERT_CONF:-/root/.config/caliber-alert.env}"
COMPOSE_DIR="${CALIBER_COMPOSE_DIR:-/opt/caliber}"
STATE_DIR="${CALIBER_ALERT_STATE_DIR:-/root/.local/state/caliber}"
WINDOW="${CALIBER_ALERT_WINDOW:-10m}"
THRESHOLD="${CALIBER_ALERT_THRESHOLD:-5}"
HEALTH_URL="${CALIBER_ALERT_HEALTH_URL:-http://localhost:3000/api/health}"

[ -f "$CONF" ] || { echo "alert-check: missing config $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${TELEGRAM_BOT_TOKEN:?alert-check: TELEGRAM_BOT_TOKEN not set in $CONF}"
: "${TELEGRAM_CHAT_ID:?alert-check: TELEGRAM_CHAT_ID not set in $CONF}"

alerts=()

# 1. On-box health (UptimeRobot covers DNS/TLS/host-Caddy from outside).
if ! curl -fsS --max-time 10 "$HEALTH_URL" > /dev/null 2>&1; then
  alerts+=("health: $HEALTH_URL failing on-box")
fi

# 2. Disk.
DISK_PCT="$(df -P / | awk 'NR==2 { sub(/%/, "", $5); print $5 }')"
if [ "$DISK_PCT" -ge 90 ]; then
  alerts+=("disk: root filesystem at ${DISK_PCT}%")
fi

# 3. Stale backup (>26h since scripts/backup.sh last wrote its marker).
MARKER="$STATE_DIR/backup-last-success"
if [ ! -f "$MARKER" ] || [ "$(( $(date +%s) - $(cat "$MARKER") ))" -gt $((26 * 3600)) ]; then
  alerts+=("backup: no successful off-box snapshot in >26h")
fi

# 4. Log classifier over the cron window.
LOGS="$(cd "$COMPOSE_DIR" && docker compose logs app --since "$WINDOW" 2>&1 || true)"

PAGE_FIRST=(
  "crashed unexpectedly"
  "failed to persist 'failed'"
  "correlate run .* crashed:"
  "daily cost cap reached"
  "url-check worker: drain loop error"
  "url-check worker: drain slot crashed"
  "url-check admission: kick failed"
)

PAGE_THRESHOLD=(
  "connector \".*\" failed:"
  "scoring job .* failed:"
  "detail fetch for job .* failed:"
  "pipeline failed:"
  "processRow crashed for row"
  "url-check worker: sweep failed"
  "detail fetch failed:"
  "evaluate failed:"
  "failed to persist partial stats"
  "\[client-error\]"
)

first_hits=()
for pattern in "${PAGE_FIRST[@]}"; do
  n="$(printf '%s\n' "$LOGS" | grep -cE "$pattern" || true)"
  [ "$n" -gt 0 ] && first_hits+=("${pattern} x${n}")
done
if [ "${#first_hits[@]}" -gt 0 ]; then
  alerts+=("logs page-on-first: ${first_hits[*]}")
fi

threshold_total=0
threshold_summary=()
for pattern in "${PAGE_THRESHOLD[@]}"; do
  n="$(printf '%s\n' "$LOGS" | grep -cE "$pattern" || true)"
  if [ "$n" -gt 0 ]; then
    threshold_total=$((threshold_total + n))
    threshold_summary+=("${pattern} x${n}")
  fi
done
if [ "$threshold_total" -ge "$THRESHOLD" ]; then
  alerts+=("logs flakes (>=${THRESHOLD} in ${WINDOW}): ${threshold_summary[*]}")
fi

# Count-then-push-once: ONE summary message per run.
if [ "${#alerts[@]}" -gt 0 ]; then
  text="Caliber alert ($(date -u +%FT%TZ))"
  for a in "${alerts[@]}"; do
    text="$text
- $a"
  done
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="$text" > /dev/null
  echo "alert pushed: ${#alerts[@]} finding(s)"
else
  echo "ok: no findings"
fi
```

- [ ] **Step 2: Syntax check.**

Run: `bash -n scripts/alert-check.sh && chmod +x scripts/alert-check.sh && echo SYNTAX-OK`
Expected: `SYNTAX-OK`.

- [ ] **Step 3: Stub-bin scenario run** — four scenarios prove the tiers. From the repo root:

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/bin" "$SCRATCH/state" "$SCRATCH/compose"
export STUB_LOG="$SCRATCH/calls.log" FIXTURE_LOGS="$SCRATCH/fixture.log"
printf 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=c\n' > "$SCRATCH/alert.env"
date +%s > "$SCRATCH/state/backup-last-success"   # fresh marker: no backup alert

cat > "$SCRATCH/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2 $3" = "compose logs app" ]; then cat "$FIXTURE_LOGS"; fi
exit 0
EOF
cat > "$SCRATCH/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
exit 0
EOF
chmod +x "$SCRATCH/bin/"*

run_check() {
  : > "$STUB_LOG"
  PATH="$SCRATCH/bin:$PATH" \
  CALIBER_ALERT_CONF="$SCRATCH/alert.env" \
  CALIBER_ALERT_STATE_DIR="$SCRATCH/state" \
  CALIBER_COMPOSE_DIR="$SCRATCH/compose" \
  bash scripts/alert-check.sh
}

# A: clean logs + the DESIGNED fallback line -> must NOT page
printf 'app | url-check abc: tier-1 extract-gate threw, escalating to tier 2: Error\n' > "$FIXTURE_LOGS"
run_check   # expect: "ok: no findings"
grep -c sendMessage "$STUB_LOG" | grep -qx 0 && echo "A-OK (designed fallback never pages)"

# B: one crash line -> pages on first
printf 'app | search run r1 crashed unexpectedly: Error\n' > "$FIXTURE_LOGS"
run_check   # expect: "alert pushed: 1 finding(s)"
grep -q sendMessage "$STUB_LOG" && echo "B-OK (crash pages on first)"

# C: 4 connector flakes (< threshold 5) -> silent
for i in 1 2 3 4; do echo "app | search run r1: connector \"lever\" failed: timeout"; done > "$FIXTURE_LOGS"
run_check   # expect: "ok: no findings"
grep -c sendMessage "$STUB_LOG" | grep -qx 0 && echo "C-OK (below threshold silent)"

# D: 5 connector flakes (= threshold) -> pages once
for i in 1 2 3 4 5; do echo "app | search run r1: connector \"lever\" failed: timeout"; done > "$FIXTURE_LOGS"
run_check   # expect: "alert pushed: 1 finding(s)"
grep -c sendMessage "$STUB_LOG" | grep -qx 1 && echo "D-OK (threshold pages once)"
```

Expected: all four `?-OK` lines print. (The health curl is stubbed to succeed; disk check runs against the real root fs — assumed <90% on the dev Mac.)

- [ ] **Step 4: DEPLOY.md Alerting section.** Append after the Backup section:

````markdown
## Alerting

Two legs, both landing in the operator's Telegram (Decision 1 — same channel
as crash-page/feedback support):

1. **External (launch-gate leg 4, operator setup):** UptimeRobot polls
   `https://caliber.fightbase.co/api/health` — the only check that sees
   DNS/TLS/host-Caddy from outside — and pushes via the Telegram bot.
2. **On-box (first-week):** `scripts/alert-check.sh` on cron:
   ```
   */10 * * * * /opt/caliber/scripts/alert-check.sh >> /var/log/caliber-alert.log 2>&1
   ```
   Checks: on-box `/api/health`, disk ≥90%, stale backup (>26h without
   `scripts/backup.sh`'s success marker), and a tiered log classifier —
   **page-on-first** (crashes, the daily cost-cap trip, url-check worker-loop
   errors) vs **page-above-threshold** (connector/scoring/url-check flakes,
   `[client-error]` beacons; ≥5 per 10-min window). The designed url-check
   tier-escalation fallback never pages (allowlist matching). Payloads are
   summary counts only — raw log lines never leave the box.

Bot token + chat id live in `/root/.config/caliber-alert.env` (box-only, not
in git, not in `.env.production`).
````

- [ ] **Step 5: Commit.**

```bash
git add scripts/alert-check.sh DEPLOY.md
git commit -m "feat(ops): tiered Telegram alert-check script + alerting runbook"
```

---

## Final gate (execution phase, not a task)

After all tasks: `npm run check` (typecheck + full vitest + contract:check + build) must be green, then a whole-branch **Fable review** (per the SDD workflow), then `superpowers:finishing-a-development-branch`. Fold review findings into a fix wave before finishing. Remind the operator: the `OPERATOR_TELEGRAM_HANDLE` placeholder (Task 4) must carry the real handle before the first invite.

---

## Operator runbook (manual, not TDD)

These are the consolidation doc's operator-only legs — box/browser/third-party setup. They are NOT failing-test cycles; run them in this order around the code waves.

**Launch gate (all four must be true before the first invite):** credits deployed (done — merged 7ce6dae, deploy pending) · paid LLM path proven on the FINAL deployment (step 11 below) · off-box backup + one tested restore (steps 3-5) · external down-detection reaching the phone (step 6).

1. **Deploy current main to the box** (`/box` skill flow) — ships the credits work + the ~30 perf commits the box is missing.
2. **Task 1 step 1 — key-only smoke (now, <1¢):** `docker compose exec -T app npx vitest run --config vitest.smoke.config.ts src/smoke/openrouter.smoke.test.ts`. NOT the full `smoke:real` (it bundles a prod-DB write + Chromium + a scrape). A revoked/typo'd key fails here like a placeholder would.
3. **Backups — R2 + age setup:** create the R2 bucket + a scoped API token; `rclone config` the remote on the box; generate the age keypair on the Mac (`age-keygen`); private key → Mac + password manager (two places, never the box); write `/root/.config/caliber-backup.env` with `AGE_RECIPIENT=age1...` and `RCLONE_REMOTE=r2:caliber-backups`. Copy `.env.production` to the password manager manually.
4. **Install the backup cron** (`17 3 * * * /opt/caliber/scripts/backup.sh >> /var/log/caliber-backup.log 2>&1`), run it once by hand, confirm both `.age` objects in R2 and the success marker on the box.
5. **Restore drill (once, before invites, local):** pull the latest pair → `age -d` with the Mac key → boot `docker compose -p caliber-restore-drill up` with distinct volumes (cannot touch prod/dev) → log in, open a real résumé → `docker compose -p caliber-restore-drill down -v`.
6. **Alerting blocker slice (launch-gate leg 4, zero code):** BotFather → create the bot, get the token; message the bot once and read your chat_id (`https://api.telegram.org/bot<token>/getUpdates`); write `/root/.config/caliber-alert.env`; register UptimeRobot on `https://caliber.fightbase.co/api/health` with the Telegram contact.
7. **Install the alert cron** (`*/10 * * * * /opt/caliber/scripts/alert-check.sh >> /var/log/caliber-alert.log 2>&1`) after Task 3 deploys.
8. **Raise the cost cap (Decision 3):** in `/opt/caliber/.env.production`, set `CALIBER_DAILY_LLM_USD=10` (was 5; operator chose 10, not 25). Reversible. Remember it only backstops runaway *scoring* — the per-user bound is the credits wallet.
9. **Fill the real Telegram handle (Decision 1):** replace the placeholder value of `OPERATOR_TELEGRAM_HANDLE` in `src/caliber-ui/lib/support.ts` (one-line commit) — it feeds both crash pages and (via the share-URL text context) the feedback flow.
10. **Write the invite message** (WhatsApp/Telegram) including the full PDPA consent paragraph — the register-form caption (Task 5) is the short-form echo of it.
11. **Task 1 step 2 — go/no-go, AFTER the final pre-invite deploy:** fresh-account journey in-browser — register with an invite code → onboarding → upload → scan → confirm a fresh `job_scores` row with `cost_usd > 0` and `model = 'openai/gpt-oss-120b'`. This validates onboarding-for-a-new-user AND the paid path in one pass. **Then invite.**

## Tracked risks — disposition in this plan

1. **SSRF DNS-rebind residual** — ACCEPTED for the friends launch (operator decision); Task 9 amends the stale "hard blocker" comment; the undici connect-hook re-validation gates PUBLIC launch.
2. **`/login` has no rate limit** — NOT in this plan (outside the settled scope). First-week candidate: piggyback a per-IP limiter on the existing `RATE_LIMITED` idiom (`registerLimit.ts` is the 25-line template). Small, not a launch blocker.
3. **No self-serve change-password** — CLOSED by Task 6.
4. **`/api/health` reports `mode:'real'` with a blank key** — CLOSED by Task 1's code slice (`llmKeyConfigured`).

## Self-Review

**Spec coverage** (against `2026-07-16-pre-launch-hardening-plan.md`):
- Task 0 (two `db.transaction` landmines, tests against `createTestDb`) → Task 0, plus a repo-wide gate test. ✓
- Task 1 (prod LLM smoke) → operator runbook steps 2 + 11; the "optional code" health slice → Task 1 here (closes tracked risk 4). ✓
- Task 2 (backup.sh repo slice; R2/age operator legs; restore drill) → Task 2 + runbook steps 3-5. ✓
- Task 3 (Telegram transport; blocker slice operator-only; alert-check.sh with tiered literals, count-then-push-once, summary-only, health/disk/stale-backup; DEPLOY.md section; token in `/root/.config/caliber-alert.env`) → Task 3 + runbook steps 6-7. ✓
- Task 4 (root + `(app)` error.tsx, skip thin groups; beacon with optional auth, server-side userId, size-cap-before-parse 413, XFF per-IP limit, 204; sendBeacon+keepalive fallback; `[client-error]` log; honest copy + Telegram link) → Task 4. ✓
- Task 5 (consent caption in AuthCard's caption register — via the invite-field `extraFields` sibling since credits shipped first; 13-table FK-safe delete incl. `credit_ledger`; dry-run/`--confirm`; uploads rm; two-graph test) → Task 5. ✓
- Task 6 (generated 12-char password, never argv; dry-run/`--confirm`; new `deleteAllByUserId` + `updatePasswordHash`; PATCH /api/auth/password with reverify; profile form; contract-first) → Task 6. ✓
- Task 7 (JobDetail only; real `<a>`, quiet `--text-muted`; `t.me/share/url` with title/company/tier/jobId/lead-in, no description; hardcoded handle) → Task 7. ✓
- Task 8 (3 queries; `.mode box`; snapshot-copy-only; epoch-ms and createdAt-clobber caveats) → Task 8. ✓
- Global constraints copied verbatim; sequencing + all three collision notes honored (waves table); tracked risks all dispositioned; operator-manual steps captured un-TDD'd. ✓

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step carries complete code; every run step has a command + expected output. Three labelled adaptation points (not placeholders): Task 5/6 DOM tests say to fall back to `AuthCard.dom.test.tsx`'s query idiom if the kit `Input` doesn't associate labels; Task 7's DOM test says to reuse the file's render-props helper if present; `OPERATOR_TELEGRAM_HANDLE` is an intentional operator-filled placeholder (runbook step 9, flagged in the final gate).

**Type consistency:** `ClientErrorReport` identical across types (T4 S3), route parse (S5), helper construction (S11), registry (S7). `checkClientErrorLimit(ip, now?)` mirrors `checkRegisterLimit`'s shape. `updatePasswordHash(id, passwordHash)` / `deleteAllByUserId(userId)` identical in repo impl (T6 S2), reset script (S5), route (S8), and mocks (S7). `ChangePasswordRequest` identical in types (S8), route (S8), client (S12), registry (S9). `buildVerdictFeedbackUrl(job: Job)` identical in T7 S3/S5/S6. `backup-last-success` marker path identical in backup.sh (T2), alert-check.sh (T3), and both DEPLOY.md sections. `deleteUser(db, userId)` / `countUserRows(db, userId)` identical in impl and test.

**Risks flagged:** Task 0's concurrency test is nondeterministic PRE-fix (stated in-step; the gate test is the deterministic red). Task 6 Step 7 widens the shared session mock in `auth.route.test.ts` — behaviour-identical for existing tests, verified by running the whole file. Task 5's `TABLES` array uses explicit `SQLiteTable`/`AnySQLiteColumn` typing to keep the heterogeneous union `tsc`-green.
