# Tailor Phase 2 — Correlation Report UI + ATS Delta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the already-persisted `CorrelationReport` as an explicit "measure → rewrite" step folded into the existing `/jobs/[id]/tailor` page, and add a deterministic ATS before→after delta computed at finalize.

**Architecture:** Pure additive UI + one backend measurement. The correlate/rewrite routes and `reportId` shipped in Phase 1; this plan wires the client + UI and adds `TailoredResume.atsDelta` (recomputed on the accepted merge at finalize). The page owns an expanded state machine (`configuring → correlating → report → rewriting → review → saved`, plus `needs-score`/`error`); the report renders as a new presentational `TailorReport` composition (layout A: two separate signals, status-grouped rows).

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod (`src/types` = contract source of truth), Drizzle + Postgres (drizzle-kit migrations), Vitest (+ jsdom DOM tests), Storybook, Playwright (e2e). Kit primitives in `src/caliber-ui/components`.

## Global Constraints

- **Contract source of truth:** Zod in `src/types/index.ts` → run `npm run contract` to regenerate `contract/openapi.json`; `npm run contract:check` must pass (no drift). Mirror any contract prose into `docs/architecture/api-contract.md`.
- **Fail loud:** validate at boundaries; no fallback defaults, no silent `0`/`""`/`unknown`. A null/absent report is an error, not an empty render.
- **Two signals, never fused:** the report renders `semantic` (met+buried of total) and `ats` (present of total) as two labelled readouts. No single fused percentage anywhere.
- **Surgical diffs, match existing style.** Compose the 13 kit primitives; do NOT add a 14th global primitive (the segmented bar stays local to `compositions/Tailor/`).
- **Dev-DB migrate gotcha:** `npm run db:migrate` reads `.env.local` (absent); `next dev` reads `.env` → the `caliber` DB. When migrating the dev DB, pass `DATABASE_URL` inline: `DATABASE_URL=<caliber-url> npm run db:migrate`.
- **Commits:** conventional-commit messages, `feat(tailor):` / `test(tailor):` scope. Never add a `Co-Authored-By: Claude` trailer.
- **Verification per task:** `npm test` (deterministic suite) must stay green; `npm run check` (tsc) must stay green.
- **Wave order:** W1 (Tasks 1–2) blocks everything. W2 (Tasks 3–4) and W3 (Tasks 5–8) both depend only on W1 and run in parallel. W4 (Tasks 9–11) depends on W2 + W3.

---

### Task 1: `atsDelta` contract field + schema column + migration

**Wave:** 1 · **Tier:** Sonnet (low–med)

**Files:**
- Modify: `src/types/index.ts` (the `TailoredResume` object, ~line 309)
- Modify: `src/server/persistence/schema.ts` (the `tailoredResumes` table, ~line 218)
- Modify: `src/server/tailor/assemble.ts` (`toTailoredResume` return object)
- Generate: `drizzle/00NN_*.sql` (via `drizzle-kit generate`)
- Regenerate: `contract/openapi.json` (via `npm run contract`)
- Modify: `docs/architecture/api-contract.md` (TailoredResume prose)

**Interfaces:**
- Produces: `TailoredResume.atsDelta: { before: number; after: number; total: number } | null`
- Produces: `tailoredResumes.atsDelta` column (`jsonb`, nullable), typed `{ before: number; after: number; total: number }`.

- [ ] **Step 1: Add the Zod field.** In `src/types/index.ts`, inside `export const TailoredResume = z.object({ ... })`, after the `reportId` line, add:

```ts
  atsDelta: z
    .object({ before: z.number().int(), after: z.number().int(), total: z.number().int() })
    .nullable(),
```

- [ ] **Step 2: Add the schema column.** In `src/server/persistence/schema.ts`, inside `export const tailoredResumes = pgTable("tailored_resumes", { ... })`, after the `acceptedIndices` column, add:

```ts
  atsDelta: jsonb("ats_delta").$type<{ before: number; after: number; total: number }>(),
```

(`jsonb` is already imported in this file.)

- [ ] **Step 3: Surface it in the assembler.** In `src/server/tailor/assemble.ts`, in the object `toTailoredResume` returns, add:

```ts
    atsDelta: row.atsDelta ?? null,
```

- [ ] **Step 4: Generate the migration.**

Run: `npm run db:generate`
Expected: a new `drizzle/00NN_*.sql` file adding `ats_delta jsonb` to `tailored_resumes`, plus an updated `drizzle/meta/_journal.json`.

- [ ] **Step 5: Regenerate the contract.**

Run: `npm run contract`
Expected: `contract/openapi.json` now includes `atsDelta` on `TailoredResume`.

- [ ] **Step 6: Update the contract doc.** In `docs/architecture/api-contract.md`, in the `TailoredResume` entity description, add a line documenting `atsDelta` (nullable; `before`/`after` = literal ATS keyword-present counts on the base vs. the accepted merge, `total` = report term count; null until finalized / for legacy rows).

- [ ] **Step 7: Verify tsc + contract.**

Run: `npm run check && npm run contract:check`
Expected: both PASS (no type errors, no contract drift).

- [ ] **Step 8: Commit.**

```bash
git add src/types/index.ts src/server/persistence/schema.ts src/server/tailor/assemble.ts drizzle/ contract/openapi.json docs/architecture/api-contract.md
git commit -m "feat(tailor): add TailoredResume.atsDelta contract field + column"
```

---

### Task 2: `atsPresentCount` helper

**Wave:** 1 · **Tier:** Sonnet (low)

**Files:**
- Modify: `src/server/tailor/correlate-metrics.ts`
- Test: `src/server/tailor/correlate-metrics.test.ts`

**Interfaces:**
- Produces: `export function atsPresentCount(terms: string[], store: ResumeStore): number` — count of `terms` that occur (same normalization as `verifyEvidence`) in `store`. Reuses the existing private `matches` + exported `flattenResumeText`; do NOT duplicate normalization.

- [ ] **Step 1: Write the failing test.** Append to `src/server/tailor/correlate-metrics.test.ts`:

```ts
import { atsPresentCount } from "./correlate-metrics";
// (reuse the file's existing ResumeStore builder / fixture; a minimal store works)

describe("atsPresentCount", () => {
  const store = makeResumeStore({
    summary: "Built CI/CD pipelines on GitHub Actions",
    experience: [{ bullets: ["Deployed containerized microservices"] }],
  }); // adapt to the test file's existing store helper

  it("counts only terms present in the flattened résumé", () => {
    expect(atsPresentCount(["CI/CD", "GitHub Actions", "Kubernetes", "Terraform"], store)).toBe(2);
  });

  it("is 0 for an empty term list", () => {
    expect(atsPresentCount([], store)).toBe(0);
  });
});
```

(Match the existing test file's `ResumeStore` construction helper — reuse it rather than hand-rolling a store.)

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts -t atsPresentCount`
Expected: FAIL — `atsPresentCount` is not exported.

- [ ] **Step 3: Implement.** In `src/server/tailor/correlate-metrics.ts`, add (after `atsSignal`):

```ts
export function atsPresentCount(terms: string[], store: ResumeStore): number {
  const text = flattenResumeText(store);
  return terms.filter((t) => matches(text, t)).length;
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts -t atsPresentCount`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/tailor/correlate-metrics.ts src/server/tailor/correlate-metrics.test.ts
git commit -m "test(tailor): atsPresentCount helper for post-merge ATS delta"
```

---

### Task 3: `finalizeTailor` computes the ATS delta

**Wave:** 2 (needs Task 1, 2) · **Tier:** Sonnet (med)

**Files:**
- Modify: `src/server/persistence/repos/tailoredResumes.ts` (`finalize` patch type)
- Modify: `src/server/tailor/index.ts` (`finalizeTailor`, ~line 314)
- Test: `src/server/tailor/index.test.ts` (or the existing finalize test file) + `src/app/api/tailor/[id]/finalize/route.test.ts`

**Interfaces:**
- Consumes: `atsPresentCount(terms, store)` (Task 2); `TailoredResume.atsDelta` (Task 1); `correlationReportsRepo.getById(id, userId)` + `toCorrelationReport(row)` (existing, `@/server/tailor/correlate`).
- Produces: `finalizeTailor` persists `atsDelta` on the row; `toTailoredResume` returns it.

- [ ] **Step 1: Widen the repo `finalize` patch.** In `src/server/persistence/repos/tailoredResumes.ts`, change the `finalize` signature to accept the delta:

```ts
    async finalize(
      id: string,
      patch: {
        acceptedIndices: number[];
        finalizedAt: Date;
        atsDelta: { before: number; after: number; total: number } | null;
      },
    ): Promise<TailoredResumeRow | null> {
      const [updated] = await db.update(tailoredResumes).set(patch).where(eq(tailoredResumes.id, id)).returning();
      return updated ?? null;
    },
```

- [ ] **Step 2: Write the failing test.** In the finalize test, assert the delta is computed from the linked report's `ats.present` (before) and the accepted merge (after). Add a case where accepting the k8s-surfacing edit raises `after`:

```ts
it("finalize computes atsDelta: before from the report, after from the accepted merge", async () => {
  // Arrange: a completed tailored_resumes row with reportId -> a correlation
  // report whose ats = { present: 3, total: 7 }, and a diff whose accepted
  // edit introduces the term "kubernetes" into the merged résumé.
  const result = await finalizeTailor(tailoredId, userId, [kubernetesEditIndex]);
  expect(result.atsDelta).toEqual({ before: 3, after: 4, total: 7 });
});

it("finalize leaves atsDelta null when reportId is null (legacy row)", async () => {
  const result = await finalizeTailor(legacyTailoredId, userId, []);
  expect(result.atsDelta).toBeNull();
});
```

(Use the test file's existing repo/seed helpers to build the report + tailored rows.)

- [ ] **Step 2b: Run test to verify it fails.**

Run: `npx vitest run src/server/tailor/index.test.ts -t atsDelta`
Expected: FAIL — `finalize` doesn't set `atsDelta` yet.

- [ ] **Step 3: Implement the recompute.** In `src/server/tailor/index.ts`, replace the body of `finalizeTailor` from the `applyAcceptedDiff` line through the `finalize` call with:

```ts
  const merged = applyAcceptedDiff(baseResumeRow.structured, row.diff, acceptedIndices);

  let atsDelta: { before: number; after: number; total: number } | null = null;
  if (row.reportId) {
    const reportRow = await correlationReportsRepo.getById(row.reportId, userId);
    if (!reportRow) throw new Error(`tailored_resumes ${id}: report ${row.reportId} no longer exists`);
    const report = toCorrelationReport(reportRow);
    const terms = report.rows.map((r) => r.term);
    atsDelta = { before: report.ats.present, after: atsPresentCount(terms, merged), total: report.ats.total };
  }

  const updated = await tailoredResumesRepo.finalize(id, { acceptedIndices, finalizedAt: new Date(), atsDelta });
  if (!updated) throw new Error(`tailored_resumes ${id} vanished during finalize`);
  return toTailoredResume(updated);
```

Add the imports at the top of `index.ts` if absent:

```ts
import { correlationReportsRepo } from "@/server/persistence/repos/correlationReports";
import { atsPresentCount } from "./correlate-metrics";
import { toCorrelationReport } from "./correlate";
```

(If `toCorrelationReport` / `correlate` create a circular import with `index.ts`, import `toCorrelationReport` from wherever `correlate.ts` re-exports it, or inline the two fields you need — `ats.present`, `ats.total`, `rows[].term` — from the raw `reportRow` jsonb columns instead of the view.)

- [ ] **Step 4: Run tests to verify they pass.**

Run: `npx vitest run src/server/tailor/index.test.ts -t atsDelta && npx vitest run src/app/api/tailor`
Expected: PASS. The finalize route test now sees `atsDelta` in the response body — extend it to assert the field is present.

- [ ] **Step 5: Full suite + tsc.**

Run: `npm test && npm run check`
Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add src/server/persistence/repos/tailoredResumes.ts src/server/tailor/index.ts src/server/tailor/index.test.ts src/app/api/tailor
git commit -m "feat(tailor): recompute literal ATS before→after delta at finalize"
```

---

### Task 4: Client — `startCorrelate` / `getCorrelate` + `startTailor` reportId

**Wave:** 2 (needs Task 1) · **Tier:** Sonnet (low)

**Files:**
- Modify: `src/features/tailor/client.ts`
- Test: `src/features/tailor/client.test.ts` (create if absent; mirror an existing `features/*/client.test.ts`)

**Interfaces:**
- Produces: `startCorrelate(input: { jobId: string }): Promise<CorrelationReport>` → `POST /api/tailor/correlate`.
- Produces: `getCorrelate(id: string): Promise<CorrelationReport>` → `GET /api/tailor/correlate/:id`.
- Produces: `startTailor(input: { jobId: string; reportId?: string }): Promise<TailoredResume>` (reportId now optional-forwarded).

- [ ] **Step 1: Write the failing test.** Mock `fetch` (as sibling client tests do) and assert `startCorrelate` POSTs to `/api/tailor/correlate` with `{ jobId }` and parses a `CorrelationReport`; `getCorrelate` GETs `/api/tailor/correlate/:id`.

```ts
it("startCorrelate posts to the correlate route", async () => {
  fetchMock.mockResponseOnce(JSON.stringify(correlationReportFixture), { status: 202 });
  const r = await startCorrelate({ jobId: "job-1" });
  expect(fetchMock).toHaveBeenCalledWith("/api/tailor/correlate", expect.objectContaining({ method: "POST" }));
  expect(r.id).toBe(correlationReportFixture.id);
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/features/tailor/client.test.ts`
Expected: FAIL — `startCorrelate` not exported.

- [ ] **Step 3: Implement.** In `src/features/tailor/client.ts`, add `CorrelationReport` to the type import and add:

```ts
export async function startCorrelate(input: { jobId: string }): Promise<CorrelationReport> {
  return requestJson(
    "/api/tailor/correlate",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    CorrelationReport,
  );
}

export async function getCorrelate(id: string): Promise<CorrelationReport> {
  return requestJson(`/api/tailor/correlate/${id}`, undefined, CorrelationReport);
}
```

And change `startTailor`'s signature to forward `reportId`:

```ts
export async function startTailor(input: { jobId: string; reportId?: string }): Promise<TailoredResume> {
  return requestJson(
    "/api/tailor",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    TailoredResume,
  );
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/features/tailor/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/features/tailor/client.ts src/features/tailor/client.test.ts
git commit -m "feat(tailor): client startCorrelate/getCorrelate + startTailor reportId"
```

---

### Task 5: `SignalBar` — local segmented bar

**Wave:** 3 (needs Task 1 types) · **Tier:** Sonnet (low)

**Files:**
- Create: `src/caliber-ui/compositions/Tailor/SignalBar.tsx`
- Test: `src/caliber-ui/compositions/Tailor/SignalBar.dom.test.tsx`

**Interfaces:**
- Produces: `SignalBar({ segments }: { segments: { value: number; color: string }[] })` — a horizontal bar whose children flex proportionally to `value`; zero-value segments are omitted.

- [ ] **Step 1: Write the failing test.**

```tsx
import { render } from "@testing-library/react";
import { SignalBar } from "./SignalBar";

it("renders one div per non-zero segment", () => {
  const { container } = render(
    <SignalBar segments={[{ value: 3, color: "red" }, { value: 0, color: "blue" }, { value: 2, color: "green" }]} />,
  );
  const track = container.firstChild as HTMLElement;
  expect(track.children).toHaveLength(2); // the zero segment is dropped
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/SignalBar.dom.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

```tsx
"use client";
import * as React from "react";

export interface SignalBarProps {
  segments: { value: number; color: string }[];
}

// SignalBar — a proportional multi-segment track (met/buried/gap). Local to
// the Tailor composition; the single-fill FitBar primitive covers the ATS row.
export function SignalBar({ segments }: SignalBarProps) {
  return (
    <div style={{ display: "flex", height: 9, borderRadius: 6, overflow: "hidden", background: "var(--surface-sunken)" }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => (
          <div key={i} style={{ flex: s.value, background: s.color }} />
        ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/SignalBar.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/caliber-ui/compositions/Tailor/SignalBar.tsx src/caliber-ui/compositions/Tailor/SignalBar.dom.test.tsx
git commit -m "feat(tailor): SignalBar local segmented bar"
```

---

### Task 6: `TailorReport` composition + fixture + stories + DOM test

**Wave:** 3 (needs Task 1, 5) · **Tier:** Sonnet build + **Fable review**

**Files:**
- Create: `src/caliber-ui/compositions/Tailor/TailorReport.tsx`
- Create: `src/caliber-ui/compositions/Tailor/TailorReport.stories.tsx`
- Test: `src/caliber-ui/compositions/Tailor/TailorReport.dom.test.tsx`
- Modify: the fixtures barrel imported as `../../fixtures` (`src/caliber-ui/fixtures.ts`) — add a `correlationReport` fixture.

**Interfaces:**
- Consumes: `CorrelationReport`, `CorrelationRow` (`@/types`); `SignalBar` (Task 5); `Tag`, `FitBar`, `Chip`, `Icon` primitives.
- Produces: `TailorReport({ report, rewriting, onRewrite }: { report: CorrelationReport; rewriting: boolean; onRewrite(): void })`.

- [ ] **Step 1: Add the fixture.** In `src/caliber-ui/fixtures.ts`, add and export a realistic `CorrelationReport`:

```ts
export const correlationReport: CorrelationReport = {
  id: "report-1", jobId: "job-1", resumeId: "resume-1",
  status: "completed", progress: null, model: "cheap-model", costUsd: 0.0004,
  createdAt: "2026-07-16T00:00:00.000Z", completedAt: "2026-07-16T00:00:03.000Z",
  semantic: { met: 3, buried: 2, gap: 2, total: 7 },
  ats: { present: 3, total: 7, missing: ["kubernetes", "go", "terraform", "kafka"] },
  rows: [
    { requirement: "Kubernetes at production scale", term: "kubernetes", kind: "must", status: "buried",
      evidence: "deployed containerized microservices across managed clusters", atsPresent: false,
      reason: "Experience present but never names Kubernetes.", note: null },
    { requirement: "Event-driven architecture (Kafka)", term: "kafka", kind: "nice", status: "buried",
      evidence: "built async data pipelines backed by message queues", atsPresent: false,
      reason: "Adjacent experience; Kafka not named.", note: null },
    { requirement: "CI/CD pipeline ownership", term: "ci/cd", kind: "must", status: "met",
      evidence: "owned GitHub Actions CI/CD across 12 services", atsPresent: true,
      reason: "Explicit and prominent.", note: null },
    { requirement: "Mentor engineers", term: "mentoring", kind: "responsibility", status: "met",
      evidence: "led and mentored a team of five backend engineers", atsPresent: true,
      reason: "Explicit.", note: null },
    { requirement: "On-call rotation", term: "on-call", kind: "responsibility", status: "met",
      evidence: "participated in 24/7 on-call rotation", atsPresent: true, reason: "Explicit.", note: null },
    { requirement: "7+ years Go", term: "go", kind: "must", status: "gap", evidence: null, atsPresent: false,
      reason: "No Go experience on the résumé.", note: "supportable via 6 yrs Python/Java backend" },
    { requirement: "Terraform / IaC", term: "terraform", kind: "nice", status: "gap", evidence: null,
      atsPresent: false, reason: "No IaC tooling mentioned.", note: null },
  ],
};
```

(Add `CorrelationReport` to that file's type import.)

- [ ] **Step 2: Write the failing DOM test.**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { TailorReport } from "./TailorReport";
import { correlationReport } from "../../fixtures";

const noop = () => {};

describe("TailorReport (spec §5)", () => {
  it("shows both signals as separate readouts with no fused percentage", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText(/Requirements covered/i)).toBeInTheDocument();
    expect(screen.getByText(/ATS keywords/i)).toBeInTheDocument();
    // met+buried = 5 of 7 ; ats present = 3 of 7
    expect(screen.getByText(/5 of 7|5 · of 7|5/)).toBeInTheDocument();
  });

  it("orders groups Buried → Met → Gap", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    const headings = screen.getAllByText(/Buried|Met|Gap/).map((n) => n.textContent);
    const buried = headings.findIndex((t) => /Buried/.test(t!));
    const met = headings.findIndex((t) => /Met/.test(t!));
    const gap = headings.findIndex((t) => /Gap/.test(t!));
    expect(buried).toBeLessThan(met);
    expect(met).toBeLessThan(gap);
  });

  it("renders a verbatim evidence quote for a buried row", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText(/deployed containerized microservices/)).toBeInTheDocument();
  });

  it("lists the missing ATS terms", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText("kubernetes")).toBeInTheDocument();
  });

  it("fires onRewrite when the CTA is clicked", () => {
    const onRewrite = vi.fn();
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={onRewrite} />);
    fireEvent.click(screen.getByRole("button", { name: /rewrite to close these/i }));
    expect(onRewrite).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/TailorReport.dom.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `TailorReport.tsx`.** Layout A. Group rows by status (`buried` → `met` → `gap`); status → `Tag` tone (`met → good`, `buried → warn`, `gap → neutral`); semantic bar via `SignalBar` (`met`=`--fit-strong`, `buried`=`--fit-mid`, `gap`=`--fit-weak`); ATS via `FitBar` with `display` override; `ats.missing` via `Chip`. CTA `Button` "Rewrite to close these", `disabled={rewriting}`.

```tsx
"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Tag, type TagTone } from "../../components/Tag";
import { FitBar } from "../../components/FitBar";
import { Chip } from "../../components/Chip";
import { SignalBar } from "./SignalBar";
import type { CorrelationReport, CorrelationRow } from "../../../types";

const STATUS_TONE: Record<CorrelationRow["status"], TagTone> = { met: "good", buried: "warn", gap: "neutral" };
const GROUPS: { status: CorrelationRow["status"]; heading: string }[] = [
  { status: "buried", heading: "Buried — surface these" },
  { status: "met", heading: "Met — already strong" },
  { status: "gap", heading: "Gap — won't fabricate" },
];

export interface TailorReportProps {
  report: CorrelationReport;
  rewriting: boolean;
  onRewrite(): void;
}

export function TailorReport({ report, rewriting, onRewrite }: TailorReportProps) {
  const { semantic, ats, rows } = report;
  const covered = semantic.met + semantic.buried;
  const atsPct = ats.total === 0 ? 0 : Math.round((ats.present / ats.total) * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginBottom: 4 }}>Requirements covered</div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8 }}>
            {covered} of {semantic.total}{" "}
            <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
              · {semantic.met} met · {semantic.buried} buried · {semantic.gap} gap
            </span>
          </div>
          <SignalBar
            segments={[
              { value: semantic.met, color: "var(--fit-strong)" },
              { value: semantic.buried, color: "var(--fit-mid)" },
              { value: semantic.gap, color: "var(--fit-weak)" },
            ]}
          />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <FitBar
            label="ATS keywords present"
            value={atsPct}
            display={`${ats.present} of ${ats.total}`}
            tone={atsPct >= 70 ? "good" : atsPct >= 40 ? "warn" : "weak"}
          />
          {ats.missing.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {ats.missing.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          )}
        </div>
      </div>

      {GROUPS.map(({ status, heading }) => {
        const groupRows = rows.filter((r) => r.status === status);
        if (groupRows.length === 0) return null;
        return (
          <div key={status} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ font: "var(--type-eyebrow)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)", color: "var(--text-muted)" }}>
              {heading} · {groupRows.length}
            </div>
            {groupRows.map((r) => (
              <div key={r.requirement} style={{ borderTop: "1px solid var(--border-faint)", paddingTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag tone={STATUS_TONE[r.status]}>{r.status}</Tag>
                  <span style={{ font: "600 14px/1.4 var(--font-body)", color: "var(--text-strong)" }}>{r.requirement}</span>
                  <span style={{ font: "var(--type-caption)", color: "var(--text-faint)", textTransform: "uppercase" }}>{r.kind}</span>
                  <span style={{ marginLeft: "auto", font: "var(--type-caption)", color: r.atsPresent ? "var(--fit-strong)" : "var(--text-faint)" }}>
                    ATS {r.atsPresent ? "✓" : "✗"}
                  </span>
                </div>
                {r.evidence && (
                  <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontStyle: "italic", borderLeft: "2px solid var(--border)", paddingLeft: 10, marginTop: 5 }}>
                    “{r.evidence}”
                  </div>
                )}
                <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>
                  {r.reason}
                  {r.note && <span> · {r.note}</span>}
                </div>
              </div>
            ))}
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--border-faint)", paddingTop: 14 }}>
        <Button variant="soft-accent" iconLeft="sparkles" onClick={onRewrite} disabled={rewriting}>
          {rewriting ? "Rewriting…" : "Rewrite to close these"}
        </Button>
        <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
          Rewrites the {semantic.buried} buried + {semantic.met} met rows. Gaps stay untouched.
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass.** Adjust the "5 of 7" assertion in Step 2 to match the exact rendered text if needed.

Run: `npx vitest run src/caliber-ui/compositions/Tailor/TailorReport.dom.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write stories.** In `TailorReport.stories.tsx` (mirror `ChangeCard.stories.tsx`): a default story from the `correlationReport` fixture, plus `AllMet` (map buried→met), `AllGap` (map every row → gap, empty `missing` hidden), and a `Rewriting` (`rewriting={true}`) variant.

- [ ] **Step 7: Run Storybook build smoke + tsc.**

Run: `npm run check`
Expected: green. (Optionally `npm run build-storybook` if that is the project's story gate.)

- [ ] **Step 8: Commit.**

```bash
git add src/caliber-ui/compositions/Tailor/TailorReport.tsx src/caliber-ui/compositions/Tailor/TailorReport.stories.tsx src/caliber-ui/compositions/Tailor/TailorReport.dom.test.tsx src/caliber-ui/fixtures.ts
git commit -m "feat(tailor): TailorReport composition (layout A)"
```

---

### Task 7: `ChangeCard` shows the requirement it serves

**Wave:** 3 · **Tier:** Sonnet (low)

**Files:**
- Modify: `src/caliber-ui/compositions/Tailor/ChangeCard.tsx`
- Test: `src/caliber-ui/compositions/Tailor/ChangeCard.dom.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `change.requirement` (already on every `TailorDiffEntry`).

- [ ] **Step 1: Write the failing test.**

```tsx
import { render, screen } from "@testing-library/react";
import { ChangeCard } from "./ChangeCard";
import { tailored } from "../../fixtures";

it("labels each edit with the requirement it serves", () => {
  render(<ChangeCard change={tailored.diff[0]} accepted onToggle={() => {}} />);
  expect(screen.getByText(tailored.diff[0].requirement)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/ChangeCard.dom.test.tsx`
Expected: FAIL — requirement not rendered.

- [ ] **Step 3: Implement.** In `ChangeCard.tsx`, inside the left-hand header cluster (after the `{change.section}` eyebrow span), add a requirement label:

```tsx
          <span style={{ font: "var(--type-caption)", color: "var(--fit-mid)" }} title="Requirement this edit serves">
            ↳ {change.requirement}
          </span>
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/ChangeCard.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/caliber-ui/compositions/Tailor/ChangeCard.tsx src/caliber-ui/compositions/Tailor/ChangeCard.dom.test.tsx
git commit -m "feat(tailor): trace each diff edit back to its requirement"
```

---

### Task 8: `TailorControls` — "Analyze fit" CTA

**Wave:** 3 · **Tier:** Sonnet (low)

**Files:**
- Modify: `src/caliber-ui/compositions/Tailor/TailorControls.tsx`

**Interfaces:**
- Produces: `TailorControls` prop `onGenerate` → renamed `onAnalyze`; `status` union `"configuring" | "analyzing"`; button copy "Analyze fit" / "Analyzing…".

- [ ] **Step 1: Rename + relabel.** In `TailorControls.tsx`: rename the `onGenerate` prop to `onAnalyze` and the `status` union member `"generating"` → `"analyzing"`; update the local `const generating = status === "generating"` → `const analyzing = status === "analyzing"`; change the button to:

```tsx
        <Button variant="soft-accent" iconLeft="sparkles" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? "Analyzing…" : "Analyze fit"}
        </Button>
```

(Update the two `disabled={generating}` chip props to `disabled={analyzing}`.)

- [ ] **Step 2: Verify tsc (will fail at the call site until Task 9 rewires — that's expected within this wave; do not fix the caller here).**

Run: `npm run check`
Expected: a type error only at `TailorResume.tsx`'s `<TailorControls>` usage (rewired in Task 9). If the project gates each commit on green tsc, defer this commit and fold Task 8 into Task 9's commit instead.

- [ ] **Step 3: Commit (or fold into Task 9).**

```bash
git add src/caliber-ui/compositions/Tailor/TailorControls.tsx
git commit -m "feat(tailor): relabel tailor entry CTA to Analyze fit"
```

---

### Task 9: `TailorResume` — expanded states + `TailorReport` + ATS delta readout

**Wave:** 4 (needs Tasks 6, 8) · **Tier:** Sonnet (med)

**Files:**
- Modify: `src/caliber-ui/compositions/Tailor/TailorResume.tsx`
- Modify: `src/caliber-ui/compositions/Tailor/TailorResume.stories.tsx` (add the new states)
- Test: `src/caliber-ui/compositions/Tailor/TailorResume.dom.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `TailorReport` (Task 6); `CorrelationReport`, `TailoredResume.atsDelta` (Task 1).
- Produces: `TailorUiState = "configuring" | "correlating" | "report" | "rewriting" | "review" | "error" | "saved" | "exporting" | "needs-score"`.
- Produces: new props `report?: CorrelationReport`, `onAnalyze()`, `onRewrite()`, `needsScoreMessage?: string`. Keeps `onGenerate` removed (replaced by `onAnalyze` + `onRewrite`).

- [ ] **Step 1: Write the failing test.** Assert: `report` state renders `TailorReport`; `needs-score` renders the score-first CTA; `saved` with `tailored.atsDelta` renders "3 → 6".

```tsx
it("renders the report and fires onRewrite", () => {
  const onRewrite = vi.fn();
  render(<TailorResume {...base} status="report" report={correlationReport} onRewrite={onRewrite} />);
  fireEvent.click(screen.getByRole("button", { name: /rewrite to close these/i }));
  expect(onRewrite).toHaveBeenCalled();
});

it("shows the ATS delta in the saved state", () => {
  const saved = { ...tailored, atsDelta: { before: 3, after: 6, total: 7 } };
  render(<TailorResume {...base} status="saved" tailored={saved} />);
  expect(screen.getByText(/3 → 6/)).toBeInTheDocument();
});

it("shows the needs-score CTA on the needs-score state", () => {
  render(<TailorResume {...base} status="needs-score" needsScoreMessage="Score this job first." />);
  expect(screen.getByText(/score this job first/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/TailorResume.dom.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** Update `TailorResumeProps`: extend `TailorUiState`; replace `onGenerate` with `onAnalyze` + `onRewrite`; add `report?: CorrelationReport` and `needsScoreMessage?: string`. Wire:
  - `TailorControls` `status={status === "correlating" ? "analyzing" : "configuring"}` `onAnalyze={onAnalyze}`.
  - `correlating` → reuse the existing 3-skeleton block (rename its guard from `generating`).
  - `report` → `{status === "report" && report && <TailorReport report={report} rewriting={false} onRewrite={onRewrite} />}`.
  - `rewriting` → skeleton (same block; also pass `rewriting` to `TailorReport` if you keep it mounted, or swap to the skeleton — simplest: show skeleton).
  - `needs-score` → a centered panel with `needsScoreMessage` and a `Button` "Score this job" (the page supplies the click via a prop or routes; for MVP render a link/Button whose handler the page wires — add `onScoreJob?()`).
  - `saved` block → after the existing "Saved a copy…" line, when `tailored?.atsDelta` add:

```tsx
{tailored?.atsDelta && (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 8, font: "var(--type-body)", color: "var(--verified)" }}>
    ATS keywords <strong>{tailored.atsDelta.before} → {tailored.atsDelta.after}</strong> of {tailored.atsDelta.total}
  </div>
)}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `npx vitest run src/caliber-ui/compositions/Tailor/TailorResume.dom.test.tsx && npm run check`
Expected: PASS + tsc green.

- [ ] **Step 5: Update stories** for `correlating`/`report`/`needs-score`/`saved`-with-delta.

- [ ] **Step 6: Commit.**

```bash
git add src/caliber-ui/compositions/Tailor/TailorResume.tsx src/caliber-ui/compositions/Tailor/TailorResume.stories.tsx src/caliber-ui/compositions/Tailor/TailorResume.dom.test.tsx src/caliber-ui/compositions/Tailor/TailorControls.tsx
git commit -m "feat(tailor): report/correlating/needs-score states + ATS delta readout"
```

---

### Task 10: Page state machine — correlate → report → rewrite + 409 handling

**Wave:** 4 (needs Tasks 4, 9) · **Tier:** Sonnet (med)

**Files:**
- Modify: `src/app/(app)/jobs/[id]/tailor/page.tsx`

**Interfaces:**
- Consumes: `startCorrelate`, `getCorrelate`, `startTailor({ jobId, reportId })` (Task 4); `ApiError` (`@/features/http`); `TailorResume` new props (Task 9).

- [ ] **Step 1: Implement the expanded machine.** Replace `onGenerate` with `onAnalyze` (correlate) + `onRewrite` (tailor with reportId). Add `report` state and a `needsScoreMessage`. Key logic:

```tsx
const [report, setReport] = React.useState<CorrelationReport | undefined>();
const [needsScoreMessage, setNeedsScoreMessage] = React.useState<string | undefined>();

async function pollCorrelateUntilTerminal(reportId: string) {
  while (true) {
    const run = await getCorrelate(reportId);
    if (run.status === "completed") { setReport(run); setStatus("report"); return; }
    if (run.status === "failed") { setError("Analysis failed — try again."); setStatus("error"); return; }
    await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function onAnalyze() {
  if (!job) return;
  setStatus("correlating"); setError(undefined); setNeedsScoreMessage(undefined);
  try {
    const started = await startCorrelate({ jobId: job.id });
    await pollCorrelateUntilTerminal(started.id);
  } catch (err) {
    if (err instanceof ApiError && err.code === "CONFLICT") { setNeedsScoreMessage(err.message); setStatus("needs-score"); return; }
    setError(err instanceof Error ? err.message : "Couldn't analyze fit."); setStatus("error");
  }
}

async function onRewrite() {
  if (!job || !report) return;
  setStatus("rewriting"); setError(undefined);
  try {
    const draft = await startTailor({ jobId: job.id, reportId: report.id });
    setTailored(draft);
    await pollUntilTerminal(draft.id);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Couldn't start rewriting."); setStatus("error");
  }
}
```

Pass `report`, `onAnalyze`, `onRewrite`, `needsScoreMessage` (and an `onScoreJob` that routes to the job's scoring entry, or omit if `needs-score` renders a plain link) to `<TailorResume>`. Import `startCorrelate`, `getCorrelate`, `ApiError`, `CorrelationReport`.

- [ ] **Step 2: Manual smoke via the verify skill.** The page has no unit test today; drive it with the `verify` skill (boot recipe + LLM test-doubles) to confirm `Analyze fit → report → Rewrite → review → save shows ATS delta`, and the 409 → needs-score path. Record the run.

- [ ] **Step 3: tsc + full suite.**

Run: `npm run check && npm test`
Expected: green.

- [ ] **Step 4: Commit.**

```bash
git add "src/app/(app)/jobs/[id]/tailor/page.tsx"
git commit -m "feat(tailor): wire correlate→report→rewrite page flow + needs-score"
```

---

### Task 11: e2e — report step + rewrite + ATS delta

**Wave:** 4 (needs Task 10) · **Tier:** Sonnet (med)

**Files:**
- Modify: `e2e/tailor.spec.ts`

**Interfaces:**
- Consumes: the full wired flow (Tasks 1–10).

- [ ] **Step 1: Extend the spec.** Update the existing tailor e2e to the two-step flow: click **Analyze fit** → assert the report renders (both signal labels, a buried row, the missing-terms) → click **Rewrite to close these** → assert diff review → accept an edit → save → assert the **ATS keywords N → M** readout. Follow the file's existing fixture/mock setup (LLM test-doubles) so it stays deterministic.

- [ ] **Step 2: Run e2e.**

Run: the project's e2e command (e.g. `npm run e2e -- tailor` — match `package.json`).
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add e2e/tailor.spec.ts
git commit -m "test(tailor): e2e for measure→rewrite report flow + ATS delta"
```

---

## Final gate (execution phase, not a task)

After Tasks 1–11: run a whole-branch **Fable review** (per the SDD workflow), then `npm run check && npm test` green, then `superpowers:finishing-a-development-branch` (operator picks merge-locally). Fold any review findings into a fix wave before finishing.

## Self-Review

**Spec coverage** (against `2026-07-16-tailor-phase-2-report-ui-design.md`):
- §3.1 fold inline → Tasks 9–10. §3.2 layout A → Task 6. §3.3 one rewrite action → Task 6 CTA + Task 10 `onRewrite`. §3.4 needs-score 409 → Tasks 9–10. §3.5 atsDelta at finalize → Tasks 1–3. ✓
- §5.1 TailorReport → Task 6. §5.2 local SignalBar → Task 5. §5.3 ChangeCard requirement → Task 7. ✓
- §6 ATS delta (contract/finalize/render) → Tasks 1, 3, 9. ✓
- §7 client fns + no new routes → Task 4. ✓ §8 error handling → Tasks 9–10. ✓
- §9 files touched — all mapped. §10 testing (component/state-machine/finalize/e2e) → Tasks 5–11. ✓
- "Analyze fit" CTA → Task 8. ✓

**Placeholder scan:** no TBD/TODO; every code step carries real code. The two soft spots are labelled explicitly, not hidden: Task 2/3 say "reuse the test file's existing store/seed helpers" (the helper name is file-local), and Task 6 Step 5 says to adjust the "5 of 7" assertion to the exact rendered string. Both are intentional (can't invent a helper name that must match the file).

**Type consistency:** `atsDelta: { before; after; total } | null` identical across Zod (T1), column `$type` (T1), repo `finalize` patch (T3), and the readout (T9). `atsPresentCount(terms, store)` signature identical in T2 and T3. `startTailor({ jobId, reportId? })` in T4 matches the T10 call site. `TailorReport({ report, rewriting, onRewrite })` identical in T6 and T9. `onAnalyze`/`analyzing` renamed consistently across T8/T9/T10.

**Risk flagged:** Task 3's `toCorrelationReport` import from `correlate.ts` into `index.ts` could form a cycle; the task gives an explicit fallback (read the raw jsonb fields). Task 8 may transiently break tsc at the `TailorControls` call site until Task 9 — the task says to fold the commit into Task 9 if the project gates each commit on green tsc.
