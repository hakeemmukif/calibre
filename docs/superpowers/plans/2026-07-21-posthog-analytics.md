# PostHog Cloud Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire PostHog Cloud (EU) into Caliber for feature-usage/funnel analytics, traffic, and client-error capture, per the approved spec `docs/superpowers/specs/2026-07-21-analytics-posthog-design.md`.

**Architecture:** A new `src/features/analytics/` module (precedent: `features/client-error/`) wraps `posthog-js` behind typed no-op-until-initialised functions. A tiny client component in the root layout initialises it; feature clients call `track()` at the five spec events; AppShell identifies/resets; `reportClientError` forwards boundary errors. A `/ingest` rewrite in `next.config.mjs` proxies ingestion so adblockers don't drop events.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, `posthog-js` (new dep), Vitest + @testing-library/react.

## Global Constraints

- Layering (project CLAUDE.md): UI → `features/*` → `server/*`. Analytics is client-side only — nothing here may import `server/*`.
- Fail loud, no fallbacks: absent `NEXT_PUBLIC_POSTHOG_KEY` in production logs one `console.warn` and analytics stays OFF. Never a fallback key, never a silent stub that pretends to work.
- **Deviation from spec §3 (deliberate):** `NEXT_PUBLIC_POSTHOG_HOST` is NOT introduced. The EU region is a spec §2 decision, so the ingestion hosts are fixed in `next.config.mjs` rewrites and the client always uses `/ingest`. Only `NEXT_PUBLIC_POSTHOG_KEY` is environment config.
- Session replay OFF (`disable_session_recording: true`). Exception autocapture ON. Autocapture ON (posthog-js default).
- Event names are exactly the spec §5 snake_case literals: `resume_uploaded`, `scan_started`, `application_created`, `tailor_started`, `credits_depleted`.
- Tests: Vitest, co-located, no `test.globals` — import `describe/it/expect` from `vitest`. DOM tests need `// @vitest-environment jsdom` at the top and manual `afterEach(cleanup)`.
- `.env*` files are read-blocked by permissions — append to them via shell (`printf >>`), never Read/Edit.
- Commit after every task. No `Co-Authored-By` trailer.

---

### Task 1: Analytics core module (`events.ts` + `client.ts`)

**Files:**
- Create: `src/features/analytics/events.ts`
- Create: `src/features/analytics/client.ts`
- Test: `src/features/analytics/client.test.ts`

**Interfaces:**
- Consumes: `posthog-js` default export.
- Produces (used by every later task):
  - `EVENTS: { resumeUploaded: "resume_uploaded"; scanStarted: "scan_started"; applicationCreated: "application_created"; tailorStarted: "tailor_started"; creditsDepleted: "credits_depleted" }` and `type AnalyticsEvent` (union of the five literals) from `@/features/analytics/events`.
  - From `@/features/analytics/client`: `initAnalytics(): void`, `track(event: AnalyticsEvent, properties?: Record<string, string | number | boolean>): void`, `identify(userId: string): void`, `resetAnalytics(): void`, `captureException(error: Error): void`, `__resetAnalyticsForTest(): void`.

- [ ] **Step 1: Install the dependency**

```bash
npm install posthog-js
```

- [ ] **Step 2: Write the failing test**

Create `src/features/analytics/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

import { EVENTS } from "./events";
import {
  __resetAnalyticsForTest,
  captureException,
  identify,
  initAnalytics,
  resetAnalytics,
  track,
} from "./client";

beforeEach(() => {
  __resetAnalyticsForTest();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("event taxonomy (spec §5)", () => {
  it("matches the spec's snake_case names exactly", () => {
    expect(EVENTS).toEqual({
      resumeUploaded: "resume_uploaded",
      scanStarted: "scan_started",
      applicationCreated: "application_created",
      tailorStarted: "tailor_started",
      creditsDepleted: "credits_depleted",
    });
  });
});

describe("analytics client", () => {
  it("every call no-ops before init", () => {
    track(EVENTS.scanStarted);
    identify("usr_1");
    resetAnalytics();
    captureException(new Error("x"));
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it("does not init without a key, and calls stay no-ops", () => {
    initAnalytics();
    expect(posthog.init).not.toHaveBeenCalled();
    track(EVENTS.scanStarted);
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("inits once with the key, then forwards calls", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    initAnalytics();
    initAnalytics();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/ingest",
        capture_exceptions: true,
        disable_session_recording: true,
      }),
    );
    track(EVENTS.creditsDepleted, { feature: "scan", required: 10, balance: 0 });
    expect(posthog.capture).toHaveBeenCalledWith("credits_depleted", {
      feature: "scan",
      required: 10,
      balance: 0,
    });
    identify("usr_1");
    expect(posthog.identify).toHaveBeenCalledWith("usr_1");
    resetAnalytics();
    expect(posthog.reset).toHaveBeenCalledOnce();
    const err = new Error("boom");
    captureException(err);
    expect(posthog.captureException).toHaveBeenCalledWith(err);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/analytics/client.test.ts`
Expected: FAIL — cannot resolve `./events` / `./client`.

- [ ] **Step 4: Write the implementation**

Create `src/features/analytics/events.ts`:

```ts
// Spec §5 starter taxonomy — snake_case literals typed so a typo is a
// compile error. Add an event only when a concrete product question needs it.
export const EVENTS = {
  resumeUploaded: "resume_uploaded",
  scanStarted: "scan_started",
  applicationCreated: "application_created",
  tailorStarted: "tailor_started",
  creditsDepleted: "credits_depleted",
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];
```

Create `src/features/analytics/client.ts`:

```ts
// posthog-js wrapper (spec §3). Initialised once from PostHogInit; every
// other export no-ops until then so callers never guard. Absent key =
// analytics off (one console.warn in production — no fallback key).
import posthog from "posthog-js";
import type { AnalyticsEvent } from "./events";

let initialized = false;

export function initAnalytics(): void {
  if (initialized) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[analytics] NEXT_PUBLIC_POSTHOG_KEY missing — analytics disabled");
    }
    return;
  }
  posthog.init(key, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    defaults: "2025-05-24",
    capture_exceptions: true,
    disable_session_recording: true,
  });
  initialized = true;
}

export function track(event: AnalyticsEvent, properties?: Record<string, string | number | boolean>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function identify(userId: string): void {
  if (!initialized) return;
  posthog.identify(userId);
}

export function resetAnalytics(): void {
  if (!initialized) return;
  posthog.reset();
}

export function captureException(error: Error): void {
  if (!initialized) return;
  posthog.captureException(error);
}

// Test-only reset (same pattern as creditsStore's __resetCreditsStore).
export function __resetAnalyticsForTest(): void {
  initialized = false;
}
```

Notes for the implementer:
- `defaults: "2025-05-24"` is posthog-js's dated defaults preset — it enables history-change pageview capture (App Router route changes) among other current defaults. If the installed posthog-js's `PostHogConfig` type rejects the string, use the newest dated preset the type offers.
- `ui_host` points dashboard links/toolbar at the EU app since `api_host` is our relative proxy path.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/analytics/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/features/analytics/
git commit -m "feat(analytics): posthog wrapper module with typed event taxonomy"
```

---

### Task 2: Init component, root-layout mount, `/ingest` proxy, env examples

**Files:**
- Create: `src/features/analytics/PostHogInit.tsx`
- Test: `src/features/analytics/PostHogInit.dom.test.tsx`
- Modify: `src/app/layout.tsx` (9-line file, shown in full below)
- Modify: `next.config.mjs` (add `skipTrailingSlashRedirect` + `rewrites`; keep the existing comment block and keys)
- Append: `.env.example`, `.env.production.example` (via shell — these are read-blocked)

**Interfaces:**
- Consumes: `initAnalytics` from Task 1.
- Produces: `PostHogInit(): null` React client component from `@/features/analytics/PostHogInit`, mounted once in the root layout.

- [ ] **Step 1: Write the failing test**

Create `src/features/analytics/PostHogInit.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { initAnalytics } = vi.hoisted(() => ({ initAnalytics: vi.fn() }));
vi.mock("./client", () => ({ initAnalytics }));

import { PostHogInit } from "./PostHogInit";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PostHogInit", () => {
  it("initialises analytics on mount and renders nothing", () => {
    const { container } = render(<PostHogInit />);
    expect(initAnalytics).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/analytics/PostHogInit.dom.test.tsx`
Expected: FAIL — cannot resolve `./PostHogInit`.

- [ ] **Step 3: Write the component**

Create `src/features/analytics/PostHogInit.tsx`:

```tsx
"use client";
import * as React from "react";
import { initAnalytics } from "./client";

// Mounted once in the root layout; renders nothing. initAnalytics guards
// against double-invoke (React StrictMode runs effects twice in dev).
export function PostHogInit(): null {
  React.useEffect(() => {
    initAnalytics();
  }, []);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/analytics/PostHogInit.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount in the root layout**

Replace `src/app/layout.tsx` (currently a bare 9-line wrapper) with:

```tsx
import "@/caliber-ui/styles/tokens.css";
import { PostHogInit } from "@/features/analytics/PostHogInit";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PostHogInit />
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Add the reverse proxy to `next.config.mjs`**

The current export is exactly `{ reactStrictMode: true, serverExternalPackages: ["@napi-rs/canvas"] }` preceded by a comment block about Docker/standalone — keep both, and extend the object to:

```js
export default {
  reactStrictMode: true,
  serverExternalPackages: ["@napi-rs/canvas"],
  // PostHog reverse proxy (spec §3): first-party /ingest path so adblockers
  // don't drop events. EU region is fixed by spec §2 — not env config.
  // skipTrailingSlashRedirect is required for posthog API calls that end in
  // a slash; app routes are unaffected (we never link with trailing slashes).
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ];
  },
};
```

Order matters: the `/ingest/static/` rule must come before the catch-all `/ingest/` rule.

- [ ] **Step 7: Append env-var documentation (shell — `.env*` is read-blocked)**

```bash
printf '\n# PostHog Cloud EU (spec 2026-07-21). Absent key = analytics disabled (warns in prod).\nNEXT_PUBLIC_POSTHOG_KEY=\n' >> .env.example
printf '\n# PostHog Cloud EU (spec 2026-07-21). Project API key from https://eu.posthog.com project settings.\nNEXT_PUBLIC_POSTHOG_KEY=\n' >> .env.production.example
```

- [ ] **Step 8: Typecheck + build to verify the config parses**

Run: `npm run typecheck && npm run build`
Expected: both succeed (build proves `next.config.mjs` is valid).

- [ ] **Step 9: Commit**

```bash
git add src/features/analytics/PostHogInit.tsx src/features/analytics/PostHogInit.dom.test.tsx src/app/layout.tsx next.config.mjs .env.example .env.production.example
git commit -m "feat(analytics): init posthog via root layout + /ingest reverse proxy"
```

---

### Task 3: Pseudonymous identity in AppShell

**Files:**
- Modify: `src/app/AppShell.tsx:61-79` (the user-change effect and `handleLogout`)

**Interfaces:**
- Consumes: `identify(userId: string)`, `resetAnalytics()` from Task 1.
- Produces: nothing new — behavioural wiring only.

- [ ] **Step 1: Wire identify + reset**

Add to the imports in `src/app/AppShell.tsx`:

```tsx
import { identify, resetAnalytics } from "@/features/analytics/client";
```

Replace the existing user-change effect (currently lines 61-68, the `prevUserId` block) with:

```tsx
  const prevUserId = React.useRef(user?.id);
  React.useEffect(() => {
    if (prevUserId.current !== undefined && prevUserId.current !== user?.id) {
      __resetChecksStore();
      __resetCreditsStore();
      resetAnalytics();
    }
    prevUserId.current = user?.id;
    // Internal id only — never email/name (spec §4).
    if (user?.id) identify(user.id);
  }, [user?.id]);
```

In `handleLogout` (currently lines 70-79), add `resetAnalytics();` directly after the existing `__resetCreditsStore();` line so the block reads:

```tsx
    __resetChecksStore();
    __resetCreditsStore();
    resetAnalytics();
    router.push("/login");
```

- [ ] **Step 2: Typecheck + run the existing suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — `identify`/`resetAnalytics` no-op when posthog was never initialised, so existing AppShell-adjacent tests are unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/app/AppShell.tsx
git commit -m "feat(analytics): pseudonymous identify on login change, reset on logout"
```

---

### Task 4: The five product events

**Files:**
- Modify: `src/features/resume/client.ts:23` (`uploadResume`)
- Modify: `src/features/search/client.ts:20` (`startSearch`)
- Modify: `src/features/applied/client.ts:16-22` (`markApplied`)
- Modify: `src/features/tailor/client.ts:15` (`startTailor`)
- Modify: `src/features/credits/creditsStore.ts:32-35` (`showDenial`)

**Interfaces:**
- Consumes: `track`, `EVENTS` from Task 1.
- Produces: nothing new — events fire after the API call succeeds, so a thrown `ApiError` (e.g. INSUFFICIENT_CREDITS, a 402) never double-counts as a started action; the failed attempt surfaces as `credits_depleted` via `showDenial` instead.

- [ ] **Step 1: Add the import to each of the four feature clients**

In `src/features/resume/client.ts`, `src/features/search/client.ts`, `src/features/tailor/client.ts`:

```ts
import { track } from "@/features/analytics/client";
import { EVENTS } from "@/features/analytics/events";
```

In `src/features/applied/client.ts` the same two lines (it has no analytics imports today).

- [ ] **Step 2: Fire the events**

`uploadResume` (resume/client.ts) — after the existing `refreshCredits();` line, before `return resume;`:

```ts
  refreshCredits();
  track(EVENTS.resumeUploaded);
  return resume;
```

`startSearch` (search/client.ts) — after its `refreshCredits();`, before `return run;`:

```ts
  refreshCredits();
  track(EVENTS.scanStarted);
  return run;
```

`markApplied` (applied/client.ts) — currently returns the `requestJson` promise directly; restructure to:

```ts
export async function markApplied(input: MarkAppliedInput): Promise<Application> {
  const application = await requestJson(
    "/api/applications",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    Application,
  );
  track(EVENTS.applicationCreated);
  return application;
}
```

`startTailor` (tailor/client.ts) — after its `refreshCredits();`, before `return tailored;`:

```ts
  refreshCredits();
  track(EVENTS.tailorStarted);
  return tailored;
```

`showDenial` (credits/creditsStore.ts) — the single chokepoint every INSUFFICIENT_CREDITS catch site funnels through:

```ts
export function showDenial(d: CreditDenial): void {
  denial = d;
  track(EVENTS.creditsDepleted, { feature: d.feature, required: d.required, balance: d.balance });
  emit();
}
```

with the same two imports added at the top of `creditsStore.ts` (no import cycle: `analytics/client` imports nothing from `features/*`).

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — `track` no-ops when uninitialised, so existing tests of these clients/stores (which never call `initAnalytics`) see no behaviour change. If any test mocks `posthog-js` transitively and fails on import, mock `@/features/analytics/client` in that test the same way `error.test.tsx` mocks `@/features/client-error/report`.

- [ ] **Step 4: Commit**

```bash
git add src/features/resume/client.ts src/features/search/client.ts src/features/applied/client.ts src/features/tailor/client.ts src/features/credits/creditsStore.ts
git commit -m "feat(analytics): instrument the 5 starter product events"
```

---

### Task 5: Boundary errors to PostHog

**Files:**
- Modify: `src/features/client-error/report.ts:7-9` (`reportClientError`)

**Interfaces:**
- Consumes: `captureException` from Task 1.
- Produces: nothing new. Both error boundaries (`src/app/error.tsx`, `src/app/(app)/error.tsx`) already call `reportClientError`, so one edit covers both — and `src/app/error.test.tsx` mocks this module wholesale, so it needs no change.

- [ ] **Step 1: Forward to posthog inside the existing try**

In `src/features/client-error/report.ts`, add the import:

```ts
import { captureException } from "@/features/analytics/client";
```

and make the first line inside the existing `try {` block:

```ts
  try {
    captureException(error);
    const report: ClientErrorReport = {
```

(Everything else in the function stays exactly as is. React-boundary-caught errors don't reach `window.onerror`, so posthog's `capture_exceptions` autocapture misses them — this manual call is why spec §7 exists. The surrounding try/catch already guarantees a failed report never cascades into the error UI.)

- [ ] **Step 2: Run the error-boundary tests + full suite**

Run: `npx vitest run src/app/error.test.tsx && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/client-error/report.ts
git commit -m "feat(analytics): capture error-boundary exceptions to posthog"
```

---

### Task 6: Full verification + operator runbook (no code)

**Files:** none created — this task is gates and operator steps.

- [ ] **Step 1: Full check**

Run: `npm run check`
Expected: typecheck, full vitest suite, contract check, and `next build` all green. (Analytics never touches `src/types`, so `contract:check` must show no diff — if it does, something leaked into the contract and is a bug.)

- [ ] **Step 2: Operator runbook — PostHog account (operator does this, ~10 min)**

1. Sign up at https://eu.posthog.com (EU region — spec §6), free plan, no card.
2. Create one project ("Caliber").
3. Project Settings → copy the Project API key (`phc_...`).
4. Locally: add `NEXT_PUBLIC_POSTHOG_KEY=phc_...` to `.env`; on the box: put `NEXT_PUBLIC_POSTHOG_KEY=phc_...` in the compose-level `.env` (next to docker-compose.yml) so `docker compose build` inlines it — `.env.production`/`env_file` is runtime-only and does NOT reach the build. Then redeploy.
5. In PostHog: Settings → toggle OFF "Discard client IP data"? — leave defaults; do NOT enable session replay.

- [ ] **Step 3: Manual live verification (spec §7)**

1. `npm run dev` with the key set.
2. Log in, upload a résumé (or paste text), start a scan.
3. PostHog → Activity: confirm `$pageview` events, `resume_uploaded`, `scan_started`, and that the person's distinct id equals your internal user id (`usr_...`-style string, NOT an email).
4. Open DevTools → Network: confirm events POST to `/ingest/...` (same origin), not `*.posthog.com`.
5. Repeat the DevTools `/ingest` network check on prod after deploy.

- [ ] **Step 4: First dashboards (operator, ~15 min, in PostHog UI)**

1. Web analytics tab — traffic/referrers works out of the box.
2. New insight → Funnel: `$pageview (/register)` → `resume_uploaded` → `scan_started` → `application_created`.
3. New insight → Retention on any event.
