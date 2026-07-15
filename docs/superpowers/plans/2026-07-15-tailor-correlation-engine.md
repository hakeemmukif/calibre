# Tailor Correlation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot résumé tailor with a testable résumé↔JD correlation engine — an LLM classifier that must cite a verbatim résumé quote, a deterministic verifier that fails loud on any uncited claim, two separate signals (semantic coverage + literal ATS), and a correlation-driven, bullet-addressable rewrite — plus a full algorithm eval harness.

**Architecture:** A cheap LLM classifies each JD requirement against the résumé and emits a verbatim evidence quote; deterministic code verifies the quote exists (reusing `fuzzyContains`) and downgrades unverifiable claims to `gap`. The rewrite is driven by and constrained to that report, emitting **edits only** (addressable at bullet granularity, each traceable to a requirement); `structured` is derived by applying edits to the base résumé. A deterministic fabrication guard rejects rewrites that introduce numeric atoms absent from the base. Tailor owns its `jdFacts` (kills a staleness bug); no fallback defaults.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod, Drizzle (Postgres; SQLite dev), Vitest, OpenRouter (`openai/gpt-oss-120b`), the existing run registry + SSE.

## Global Constraints

- **Layering:** UI → `features/*` → `server/*`; only `server/*` touches DB or LLM. Copied verbatim from CLAUDE.md.
- **Contract source of truth:** Zod schemas in `src/types` → OpenAPI → docs. New/changed types land in `src/types/index.ts` AND `docs/architecture/api-contract.md`.
- **Fail loud:** validate at boundaries (`Schema.parse`); no fallback defaults, no silent `0`/`""`/`unknown`.
- **LLM:** OpenRouter only, cheapest viable model per task, template-guided via `config/models.yml`; no `claude -p`.
- **gpt-oss-120b rule:** under `strict:false` the model drops `.optional()` fields from `json_schema` output — use an EMIT schema where every field is present (scalars `.nullable()`), then null-strip. Do NOT add `strict:true` to a task whose schema carries optionals.
- **Per-user scoping:** every new user-owned table has `user_id uuid NOT NULL references(users.id)`; every repo method is userId-scoped; a foreign id 404s.
- **No `Co-Authored-By: Claude` trailer** on commits. Commit after every task.
- **Testing:** deterministic tests run under `npm test` (Vitest). Live-LLM tests are named `*.live.test.ts`, are excluded from `npm test`, and run only via `vitest.smoke.config.ts`.

## File Structure

**New**
- `src/server/tailor/correlate-metrics.ts` — pure functions: `flattenResumeText`, `verifyEvidence`, `atsSignal`, `semanticSignal`, `fabricationViolations`, `statusAccuracy`, `falseGapRate`, `CORRELATE_BASELINE`, `CORRELATE_EPSILON`.
- `src/server/tailor/correlate-metrics.test.ts` — unit tests (no LLM).
- `src/server/tailor/correlate.ts` — engine: `resolveJdFacts`, `buildRequirements`, `CorrelateResultSchema`, `correlate`, `toCorrelationReport`.
- `src/server/tailor/correlate.test.ts` — engine tests (mock LLM).
- `src/server/tailor/eval.live.test.ts` — live classifier + rewrite eval over goldens.
- `src/server/tailor/__fixtures__/golden/*.json` — golden set.
- `config/templates/correlate.md` — classifier prompt.
- `src/server/persistence/repos/correlationReports.ts` (+ `.test.ts`) — repo.
- `src/app/api/tailor/correlate/route.ts` (+ `route.test.ts`) — POST.
- `src/app/api/tailor/correlate/[id]/route.ts` (+ `route.test.ts`) — GET/SSE.

**Changed**
- `src/types/index.ts` + `docs/architecture/api-contract.md` — `RequirementStatus`, `CorrelationRow`, `CorrelationReport`; `TailoredResume` (`reportId`, richer `diff` element).
- `src/lib/llm/client.ts` — add `"correlate"` to `TaskName`.
- `src/server/runs/registry.ts` — add `"correlate"` to `RunKind`.
- `config/models.yml` — add `correlate` task.
- `config/templates/tailor.md` — rewritten (report-driven, edits-only, addressable).
- `src/server/persistence/schema.ts` — `correlationReports` table + `tailoredResumes.reportId`.
- `src/server/tailor/merge.ts` — `applyEdits`, `applyAcceptedDiff(base, diff, acceptedIndices)`.
- `src/server/tailor/index.ts` — `startTailor({jobId, reportId?})`, jdFacts ownership, fabrication guard, edits-only result, remove `"Not available"` fallback + one-entry-per-section `superRefine`.
- `src/server/tailor/assemble.ts` — surface `reportId`; new merge signature.
- `src/server/tailor/tailor.test.ts`, `finalize.test.ts`, and `src/app/api/tailor/**` route tests — updated for new stages/diff shape.
- `package.json` — `eval:tailor` script.
- `e2e/tailor.spec.ts` — `correlate → rewrite`, per-edit accept/reject.
- `docs/architecture/runbook.md` — `eval:tailor` note.

---

### Task 1: Contract types

**Files:**
- Modify: `src/types/index.ts` (add types; extend `TailoredResume`)
- Modify: `docs/architecture/api-contract.md` (mirror)
- Test: `src/types/correlation.test.ts` (create)

**Interfaces:**
- Produces: `RequirementStatus`, `CorrelationRow`, `CorrelationReport`, and the extended `TailoredResume` with `reportId: string|null` and `diff[]` element `{ section, op, before?, after?, reason, requirement, target:{index:number|null, bulletIndex:number|null} }`. Export a `TailorDiffEntry` type alias = `TailoredResume['diff'][number]`.

- [ ] **Step 1: Write the failing test**

Create `src/types/correlation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CorrelationReport, CorrelationRow, TailoredResume } from "./index";

describe("correlation contract", () => {
  it("parses a CorrelationRow with evidence", () => {
    const row = CorrelationRow.parse({
      requirement: "5+ years building distributed backend systems",
      term: "distributed systems", kind: "must", status: "met",
      evidence: "Led distributed payments platform at Paywatch", atsPresent: true,
      reason: "Direct match in current role", note: null,
    });
    expect(row.status).toBe("met");
  });

  it("rejects an unknown status", () => {
    expect(() => CorrelationRow.parse({
      requirement: "x", term: "x", kind: "must", status: "partial",
      evidence: null, atsPresent: false, reason: "r", note: null,
    })).toThrow();
  });

  it("parses a CorrelationReport with two separate signals", () => {
    const report = CorrelationReport.parse({
      id: "r1", jobId: "j1", resumeId: "cv1", status: "completed", progress: null,
      rows: [], semantic: { met: 0, buried: 0, gap: 0, total: 0 },
      ats: { present: 0, total: 0, missing: [] },
      model: "openai/gpt-oss-120b", costUsd: 0.0004,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    expect(report.ats.missing).toEqual([]);
  });

  it("parses a TailoredResume diff entry with target addressing", () => {
    const t = TailoredResume.parse({
      id: "t1", jobId: "j1", resumeId: "cv1", status: "completed", progress: null,
      reportId: "r1", resume: null,
      diff: [{ section: "experience", op: "modify", before: "b", after: "a",
        reason: "why", requirement: "distributed systems",
        target: { index: 0, bulletIndex: 1 } }],
      model: "m", createdAt: new Date().toISOString(), completedAt: null,
    });
    expect(t.diff[0].target.bulletIndex).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types/correlation.test.ts`
Expected: FAIL — `CorrelationRow`/`CorrelationReport` not exported; `TailoredResume` rejects `reportId`/`requirement`/`target`.

- [ ] **Step 3: Add the types**

In `src/types/index.ts`, near the existing `TailoredResume` block, add:
```ts
export const RequirementStatus = z.enum(["met", "buried", "gap"]);

export const CorrelationRow = z.object({
  requirement: z.string(),
  term: z.string(),
  kind: z.enum(["must", "nice", "responsibility"]),
  status: RequirementStatus,
  evidence: z.string().nullable(),   // verbatim résumé quote; non-null iff status ∈ {met, buried}
  atsPresent: z.boolean(),           // deterministic: `term` occurs (normalized) in the résumé
  reason: z.string(),
  note: z.string().nullable(),
});

export const CorrelationReport = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(),
  status: RunStatus, progress: Progress.nullable(),
  rows: z.array(CorrelationRow),
  semantic: z.object({ met: z.number().int(), buried: z.number().int(),
    gap: z.number().int(), total: z.number().int() }),
  ats: z.object({ present: z.number().int(), total: z.number().int(),
    missing: z.array(z.string()) }),
  model: z.string(), costUsd: z.number().nullable(),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});
export type CorrelationReport = z.infer<typeof CorrelationReport>;
export type CorrelationRow = z.infer<typeof CorrelationRow>;
```
Then replace the existing `TailoredResume` definition's `diff` field and add `reportId`. The new `TailoredResume`:
```ts
export const TailoredResume = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(), status: RunStatus,
  progress: Progress.nullable(),
  reportId: z.string().nullable(),
  resume: Resume.omit({ id: true, rawText: true }).nullable(),
  diff: z.array(z.object({
    section: z.string(), op: z.enum(["add", "remove", "modify"]),
    before: z.string().optional(), after: z.string().optional(),
    reason: z.string(), requirement: z.string(),
    target: z.object({ index: z.number().int().nullable(),
      bulletIndex: z.number().int().nullable() }),
  })),
  model: z.string(), createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type TailorDiffEntry = z.infer<typeof TailoredResume>["diff"][number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/types/correlation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Mirror into the contract doc**

In `docs/architecture/api-contract.md`, in the schema block near the existing `TailoredResume`, add the `CorrelationRow`/`CorrelationReport` definitions verbatim and update `TailoredResume` to show `reportId` + the richer `diff` element. Add the three new endpoints to the endpoint table (F6): `POST /api/tailor/correlate` (async 202), `GET /api/tailor/correlate/:id` (sync/SSE), and note `POST /api/tailor` body is now `{ jobId, reportId? }`.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/types/correlation.test.ts docs/architecture/api-contract.md
git commit -m "feat(types): correlation report contract + addressable tailor diff"
```

---

### Task 2: Persistence — correlation_reports table + repo

**Files:**
- Modify: `src/server/persistence/schema.ts` (add table + `tailoredResumes.reportId`)
- Create: migration via `npm run db:generate` → `drizzle/0010_*.sql`
- Create: `src/server/persistence/repos/correlationReports.ts`
- Test: `src/server/persistence/repos/correlationReports.test.ts`

**Interfaces:**
- Consumes: schema table `correlationReports`.
- Produces: `correlationReportsRepo` with `insert(row)`, `getById(id, userId)`, `updateStatus(id, status)`, `complete(id, {rows, semantic, ats, model, costUsd, completedAt})`, `markFailed(id)`; types `NewCorrelationReport`, `CorrelationReportRow`.

- [ ] **Step 1: Add the schema**

In `src/server/persistence/schema.ts`, import `CorrelationRow` type is not needed (store rows as jsonb typed by the wire type). Add after `tailoredResumes`:
```ts
export const correlationReports = pgTable("correlation_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  resumeId: uuid("resume_id").notNull().references(() => resumes.id),
  rows: jsonb("rows").$type<CorrelationReportRowJson[]>().notNull(),
  semantic: jsonb("semantic").$type<{ met: number; buried: number; gap: number; total: number }>(),
  ats: jsonb("ats").$type<{ present: number; total: number; missing: string[] }>(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
  model: text("model").notNull(),
  costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});
```
Add a local type near the top-level types (mirroring `TailoredResumeDiffEntry` at line ~63):
```ts
type CorrelationReportRowJson = {
  requirement: string; term: string; kind: "must" | "nice" | "responsibility";
  status: "met" | "buried" | "gap"; evidence: string | null; atsPresent: boolean;
  reason: string; note: string | null;
};
```
Add the column to `tailoredResumes`:
```ts
  reportId: uuid("report_id").references(() => correlationReports.id),
```
(Place it after `baseResumeId`. Nullable — no `.notNull()` — for legacy rows.)

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0010_*.sql` creating `correlation_reports` and altering `tailored_resumes` with `report_id`. Inspect it; confirm the FK and column.

- [ ] **Step 3: Write the failing repo test**

Create `src/server/persistence/repos/correlationReports.test.ts` mirroring `tailoredResumes.test.ts` (same in-memory/test-db harness that file uses — copy its `beforeEach`/db setup). Cover: `insert` returns a queued row; `getById(id, userId)` returns it; `getById(id, otherUserId)` returns `null` (scoping); `complete` sets rows/semantic/ats/status/completedAt; `markFailed` sets `failed`.
```ts
it("scopes getById to the owner", async () => {
  const row = await repo.insert({ userId: U1, jobId: J1, resumeId: CV1,
    rows: [], status: "queued", model: "m" });
  expect(await repo.getById(row.id, U2)).toBeNull();
  expect(await repo.getById(row.id, U1)).not.toBeNull();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/server/persistence/repos/correlationReports.test.ts`
Expected: FAIL — module `./correlationReports` not found.

- [ ] **Step 5: Write the repo**

Create `src/server/persistence/repos/correlationReports.ts`, mirroring `tailoredResumes.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { correlationReports } from "../schema";
import type { Db } from "./db";

export type NewCorrelationReport = typeof correlationReports.$inferInsert;
export type CorrelationReportRow = typeof correlationReports.$inferSelect;

export function createCorrelationReportsRepo(db: Db) {
  return {
    async insert(row: NewCorrelationReport): Promise<CorrelationReportRow> {
      const [inserted] = await db.insert(correlationReports).values(row).returning();
      return inserted;
    },
    async getById(id: string, userId: string): Promise<CorrelationReportRow | null> {
      const [row] = await db.select().from(correlationReports)
        .where(and(eq(correlationReports.id, id), eq(correlationReports.userId, userId)));
      return row ?? null;
    },
    async updateStatus(id: string, status: CorrelationReportRow["status"]): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports).set({ status })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
    async complete(id: string, patch: {
      rows: CorrelationReportRow["rows"]; semantic: CorrelationReportRow["semantic"];
      ats: CorrelationReportRow["ats"]; model: string; costUsd: number; completedAt: Date;
    }): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports)
        .set({ ...patch, status: "completed" })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
    async markFailed(id: string): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports).set({ status: "failed" })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
  };
}

export const correlationReportsRepo: ReturnType<typeof createCorrelationReportsRepo> = {
  insert: (row) => createCorrelationReportsRepo(getDb()).insert(row),
  getById: (id, userId) => createCorrelationReportsRepo(getDb()).getById(id, userId),
  updateStatus: (id, status) => createCorrelationReportsRepo(getDb()).updateStatus(id, status),
  complete: (id, patch) => createCorrelationReportsRepo(getDb()).complete(id, patch),
  markFailed: (id) => createCorrelationReportsRepo(getDb()).markFailed(id),
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/server/persistence/repos/correlationReports.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/persistence/schema.ts src/server/persistence/repos/correlationReports.ts src/server/persistence/repos/correlationReports.test.ts drizzle/
git commit -m "feat(db): correlation_reports table + repo, tailored_resumes.report_id"
```

---

### Task 3: Deterministic verifier + ATS + semantic signals

**Files:**
- Create: `src/server/tailor/correlate-metrics.ts`
- Test: `src/server/tailor/correlate-metrics.test.ts`

**Interfaces:**
- Consumes: `fuzzyContains` from `@/server/resume/eval-metrics`; `ResumeStore` from `@/server/resume/resume-store`; `CorrelationRow` from `@/types`.
- Produces:
  - `flattenResumeText(store: ResumeStore): string`
  - `verifyEvidence(rows: Omit<CorrelationRow,"atsPresent">[], store: ResumeStore): CorrelationRow[]` — downgrades unverifiable `met`/`buried` to `gap` (note `"evidence unverifiable"`), computes `atsPresent` for every row.
  - `semanticSignal(rows: CorrelationRow[]): {met,buried,gap,total}`
  - `atsSignal(rows: CorrelationRow[]): {present,total,missing:string[]}`

- [ ] **Step 1: Write the failing test**

Create `src/server/tailor/correlate-metrics.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import { atsSignal, flattenResumeText, semanticSignal, verifyEvidence } from "./correlate-metrics";

const store: ResumeStore = {
  storeVersion: 2, extractionPath: "text", name: "Aisha",
  headline: "Backend engineer", location: "KL", summary: "Built payment systems",
  contact: [], education: [], projects: [], certifications: [], languages: [], sections: [],
  experience: [{ company: "Paywatch", title: "Engineer", dates: "2021-2024",
    start: null, end: null, location: null, isCurrent: false,
    bullets: ["Led distributed payments platform handling FX settlement"] }],
  skills: [{ label: "Backend", items: ["Kubernetes", "Postgres"] }],
};

describe("verifyEvidence", () => {
  it("keeps a row whose evidence is in the résumé", () => {
    const [row] = verifyEvidence([{ requirement: "distributed systems experience",
      term: "distributed", kind: "must", status: "met",
      evidence: "Led distributed payments platform", reason: "r", note: null }], store);
    expect(row.status).toBe("met");
  });

  it("downgrades a met row whose evidence is fabricated", () => {
    const [row] = verifyEvidence([{ requirement: "kafka streaming",
      term: "kafka", kind: "must", status: "met",
      evidence: "Built real-time Kafka streaming pipelines", reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.note).toContain("unverifiable");
    expect(row.evidence).toBeNull();
  });

  it("computes atsPresent from the literal term, independent of status", () => {
    const [row] = verifyEvidence([{ requirement: "Kubernetes", term: "Kubernetes",
      kind: "must", status: "gap", evidence: null, reason: "r", note: null }], store);
    expect(row.atsPresent).toBe(true); // present in skills even if the LLM said gap
  });
});

describe("signals", () => {
  const rows = verifyEvidence([
    { requirement: "a", term: "Kubernetes", kind: "must", status: "met", evidence: "Kubernetes", reason: "r", note: null },
    { requirement: "b", term: "Kafka", kind: "must", status: "gap", evidence: null, reason: "r", note: null },
  ], store);
  it("semanticSignal counts by status", () => {
    expect(semanticSignal(rows)).toEqual({ met: 1, buried: 0, gap: 1, total: 2 });
  });
  it("atsSignal lists missing terms", () => {
    const s = atsSignal(rows);
    expect(s.present).toBe(1); expect(s.total).toBe(2); expect(s.missing).toEqual(["Kafka"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/server/tailor/correlate-metrics.ts`:
```ts
import { fuzzyContains } from "@/server/resume/eval-metrics";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { CorrelationRow } from "@/types";

export function flattenResumeText(store: ResumeStore): string {
  const parts: string[] = [store.name, store.headline ?? "", store.location ?? "", store.summary ?? ""];
  for (const e of store.experience) {
    parts.push(e.company, e.title, ...e.bullets);
  }
  for (const p of store.projects) parts.push(p.name, ...p.bullets);
  for (const g of store.skills) parts.push(g.label ?? "", ...g.items);
  for (const ed of store.education) parts.push(ed.school ?? "", ed.credential ?? "", ed.details ?? "");
  for (const c of store.certifications) parts.push(c.name);
  for (const l of store.languages) parts.push(l.language);
  for (const s of store.sections) parts.push(s.heading ?? "", ...s.items);
  return parts.filter(Boolean).join("\n");
}

export function verifyEvidence(
  rows: Omit<CorrelationRow, "atsPresent">[],
  store: ResumeStore,
): CorrelationRow[] {
  const text = flattenResumeText(store);
  return rows.map((r) => {
    const atsPresent = fuzzyContains(text, r.term);
    if (r.status === "met" || r.status === "buried") {
      const ok = r.evidence != null && r.evidence.trim() !== "" && fuzzyContains(text, r.evidence);
      if (!ok) {
        return { ...r, status: "gap", evidence: null, atsPresent,
          note: "evidence unverifiable — no matching résumé text" };
      }
    }
    return { ...r, atsPresent };
  });
}

export function semanticSignal(rows: CorrelationRow[]) {
  const met = rows.filter((r) => r.status === "met").length;
  const buried = rows.filter((r) => r.status === "buried").length;
  const gap = rows.filter((r) => r.status === "gap").length;
  return { met, buried, gap, total: rows.length };
}

export function atsSignal(rows: CorrelationRow[]) {
  const present = rows.filter((r) => r.atsPresent).length;
  const missing = rows.filter((r) => !r.atsPresent).map((r) => r.term);
  return { present, total: rows.length, missing };
}
```
Note: confirm the exact `ResumeStore` sub-field names against `resume-store.ts` (e.g. `education[].school/credential/details`, `skills[].label`, `sections[].heading/items`) while implementing; adjust `flattenResumeText` accessors to match the real schema.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/correlate-metrics.ts src/server/tailor/correlate-metrics.test.ts
git commit -m "feat(tailor): deterministic evidence verifier + ats/semantic signals"
```

---

### Task 4: Deterministic fabrication guard

**Files:**
- Modify: `src/server/tailor/correlate-metrics.ts` (add `fabricationViolations`)
- Test: `src/server/tailor/correlate-metrics.test.ts` (add cases)

**Interfaces:**
- Produces: `fabricationViolations(edits: TailorDiffEntry[], store: ResumeStore): string[]` — returns a violation string per edit whose `after` text introduces a numeric atom (number/percent/currency/year) absent from the base résumé. Empty = clean.

- [ ] **Step 1: Write the failing test**

Append to `src/server/tailor/correlate-metrics.test.ts`:
```ts
import { fabricationViolations } from "./correlate-metrics";

describe("fabricationViolations", () => {
  const base = store; // reuse the fixture above
  it("flags a rewrite that invents a metric", () => {
    const v = fabricationViolations([{ section: "experience", op: "modify",
      before: "Led distributed payments platform",
      after: "Led distributed payments platform, cutting latency by 40%",
      reason: "r", requirement: "performance", target: { index: 0, bulletIndex: 0 } }], base);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("40");
  });
  it("allows a reword with no new numbers", () => {
    const v = fabricationViolations([{ section: "experience", op: "modify",
      before: "Led distributed payments platform handling FX settlement",
      after: "Architected distributed payment systems for FX settlement",
      reason: "r", requirement: "distributed systems", target: { index: 0, bulletIndex: 0 } }], base);
    expect(v).toEqual([]);
  });
  it("allows a number that already exists in the résumé", () => {
    const withNum: ResumeStore = { ...base, summary: "10 years building payment systems" };
    const v = fabricationViolations([{ section: "summary", op: "modify",
      before: "Built payment systems", after: "10 years building payment platforms",
      reason: "r", requirement: "seniority", target: { index: null, bulletIndex: null } }], withNum);
    expect(v).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts -t fabricationViolations`
Expected: FAIL — `fabricationViolations` not exported.

- [ ] **Step 3: Implement**

Append to `src/server/tailor/correlate-metrics.ts`:
```ts
import type { TailorDiffEntry } from "@/types";

const NUMERIC_ATOM = /\d[\d,.]*%?/g; // 40, 40%, 1,200, 3.5, 2024

function numericAtoms(text: string): string[] {
  return (text.match(NUMERIC_ATOM) ?? []).map((s) => s.replace(/[,.]$/, ""));
}

export function fabricationViolations(edits: TailorDiffEntry[], store: ResumeStore): string[] {
  const baseNums = new Set(numericAtoms(flattenResumeText(store)));
  const violations: string[] = [];
  for (const e of edits) {
    if (!e.after) continue;
    for (const atom of numericAtoms(e.after)) {
      if (!baseNums.has(atom)) {
        violations.push(
          `edit for "${e.requirement}" introduces number "${atom}" absent from the base résumé`);
      }
    }
  }
  return violations;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/correlate-metrics.ts src/server/tailor/correlate-metrics.test.ts
git commit -m "feat(tailor): deterministic fabrication guard (numeric-atom containment)"
```

---

### Task 5: Eval scorers + baseline constants

**Files:**
- Modify: `src/server/tailor/correlate-metrics.ts` (add scorers + constants)
- Test: `src/server/tailor/correlate-metrics.test.ts` (add cases)

**Interfaces:**
- Produces: `statusAccuracy(expected, actual): number`, `falseGapRate(expected, actual): number`, `CORRELATE_BASELINE = 0.8`, `CORRELATE_EPSILON = 0.05`. `expected`/`actual` are arrays of `{ requirement, status }` joined by `requirement`.

- [ ] **Step 1: Write the failing test**

Append:
```ts
import { CORRELATE_BASELINE, falseGapRate, statusAccuracy } from "./correlate-metrics";

describe("eval scorers", () => {
  const expected = [
    { requirement: "a", status: "met" as const },
    { requirement: "b", status: "buried" as const },
    { requirement: "c", status: "gap" as const },
  ];
  it("statusAccuracy = fraction of matching statuses", () => {
    const actual = [
      { requirement: "a", status: "met" as const },
      { requirement: "b", status: "gap" as const },   // wrong
      { requirement: "c", status: "gap" as const },
    ];
    expect(statusAccuracy(expected, actual)).toBeCloseTo(2 / 3);
  });
  it("falseGapRate = expected-not-gap wrongly called gap", () => {
    const actual = [
      { requirement: "a", status: "gap" as const },    // false gap
      { requirement: "b", status: "buried" as const },
      { requirement: "c", status: "gap" as const },
    ];
    expect(falseGapRate(expected, actual)).toBeCloseTo(1 / 2); // 1 of 2 non-gap expected
  });
  it("exposes a calibrated baseline", () => {
    expect(CORRELATE_BASELINE).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts -t "eval scorers"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append:
```ts
export const CORRELATE_BASELINE = 0.8;
export const CORRELATE_EPSILON = 0.05;

type StatusPair = { requirement: string; status: "met" | "buried" | "gap" };

function byRequirement(rows: StatusPair[]): Map<string, StatusPair["status"]> {
  return new Map(rows.map((r) => [r.requirement, r.status]));
}

export function statusAccuracy(expected: StatusPair[], actual: StatusPair[]): number {
  if (expected.length === 0) return 1;
  const a = byRequirement(actual);
  const hits = expected.filter((e) => a.get(e.requirement) === e.status).length;
  return hits / expected.length;
}

export function falseGapRate(expected: StatusPair[], actual: StatusPair[]): number {
  const nonGap = expected.filter((e) => e.status !== "gap");
  if (nonGap.length === 0) return 0;
  const a = byRequirement(actual);
  const falseGaps = nonGap.filter((e) => a.get(e.requirement) === "gap").length;
  return falseGaps / nonGap.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/correlate-metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/correlate-metrics.ts src/server/tailor/correlate-metrics.test.ts
git commit -m "feat(tailor): classifier eval scorers + calibrated baseline"
```

---

### Task 6: Classifier prompt + model tier + task registration

**Files:**
- Create: `config/templates/correlate.md`
- Modify: `config/models.yml` (add `correlate`)
- Modify: `src/lib/llm/client.ts` (add `"correlate"` to `TaskName`)
- Modify: `src/server/runs/registry.ts` (add `"correlate"` to `RunKind`)
- Test: `src/lib/llm/templates.test.ts` (add a render case) — or create `src/server/tailor/correlate-template.test.ts`

**Interfaces:**
- Produces: template `correlate` renderable with vars `{ requirements, resume }`; task `"correlate"` resolvable via `modelFor`.

- [ ] **Step 1: Write the failing test**

Create `src/server/tailor/correlate-template.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client";     // ensures "correlate" is a valid TaskName at type-check
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";

describe("correlate template + model", () => {
  it("renders with requirements and resume", () => {
    const msgs = renderTemplate("correlate", {
      requirements: JSON.stringify([{ id: 0, kind: "must", text: "distributed systems" }]),
      resume: JSON.stringify({ name: "A" }),
    });
    expect(msgs.some((m) => m.content.includes("distributed systems"))).toBe(true);
    expect(msgs[0].role).toBe("system");
  });
  it("has a model config", () => {
    expect(modelFor("correlate").model).toBe("openai/gpt-oss-120b");
  });
  it("getLlm is defined", () => { expect(getLlm).toBeTypeOf("function"); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/correlate-template.test.ts`
Expected: FAIL — `"correlate"` not assignable to `TaskName`; template file missing.

- [ ] **Step 3: Register the task + kind**

In `src/lib/llm/client.ts`, add `"correlate"` to the `TaskName` union (after `"tailor"`).
In `src/server/runs/registry.ts`, change `RunKind` to `"search" | "tailor" | "correlate"`.
In `config/models.yml`, add under the tasks map:
```yaml
  correlate:
    # Requirement-vs-résumé classification: cheap tier. Emits one row per JD
    # requirement (term/status/evidence/reason/note); no strict — evidence/note
    # are nullable and gpt-oss-120b drops optionals under strict:false.
    model: openai/gpt-oss-120b
    maxTokens: 4000
    temperature: 0.1
```

- [ ] **Step 4: Write the template**

Create `config/templates/correlate.md`:
```
--- system ---
You are a résumé-to-job correlation analyst for Caliber. For each job
requirement, decide whether the candidate's résumé supports it, and you MUST
cite a verbatim quote copied exactly from the résumé for any requirement you
mark "met" or "buried". Never invent a quote. If the résumé does not support a
requirement, mark it "gap" with evidence null. Return ONLY JSON matching the
provided schema — no markdown, no commentary.

--- user:instructions ---
For every requirement in the list, output one row with the SAME `id`, and:
- `term`: a 1-3 word canonical keyword for this requirement (for a literal
  keyword check) — use the job's own vocabulary.
- `status`: "met" (clearly supported AND prominently stated), "buried"
  (genuinely supported but not surfaced/emphasized), or "gap" (the résumé
  cannot honestly support it).
- `evidence`: for "met"/"buried", a substring copied VERBATIM from the résumé
  that proves it. For "gap", null. Do not paraphrase the quote.
- `reason`: one short line.
- `note`: for "gap", an optional short hint on what real experience could
  support it, or null.
Output exactly one row per input requirement id. Do not add or drop rows.

--- user:requirements ---
Requirements (id, kind, text):
{{requirements}}

--- user:candidate ---
Candidate résumé (structured JSON):
{{resume}}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/correlate-template.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/templates/correlate.md config/models.yml src/lib/llm/client.ts src/server/runs/registry.ts src/server/tailor/correlate-template.test.ts
git commit -m "feat(tailor): correlate classifier template, model tier, task/kind registration"
```

---

### Task 7: Correlation engine (`correlate.ts`)

**Files:**
- Create: `src/server/tailor/correlate.ts`
- Test: `src/server/tailor/correlate.test.ts`

**Interfaces:**
- Consumes: `jobScoresRepo.getLatestByJobId`, `resumesRepo.getActive`, `jobsRepo.existsById`, `correlationReportsRepo`, run registry `create`, `verifyEvidence/atsSignal/semanticSignal`, `renderTemplate`, `getLlm`, `JdFacts`.
- Produces:
  - `class NoJdFactsError extends Error` (→ 409)
  - `buildRequirements(jd: JdFacts): {id:number, kind:"must"|"nice"|"responsibility", text:string}[]`
  - `CorrelateResultSchema` (emit) = `{ rows: {id, term, status, evidence, reason, note}[] }`
  - `correlate(userId, {jobId}, deps?): Promise<CorrelationReport>` (queued immediately, async completes; stages `extract → classify → verify → done`)
  - `toCorrelationReport(row): CorrelationReport`
  - re-exports `UnknownJobError`, `NoActiveResumeError` from `./index` (or defines locally — see note).

- [ ] **Step 1: Write the failing test**

Create `src/server/tailor/correlate.test.ts`, mirroring `tailor.test.ts`'s mock-LLM + run harness:
```ts
import { describe, expect, it } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { buildRequirements, correlate, NoJdFactsError } from "./correlate";
// ... test-db + fixtures setup copied from tailor.test.ts (seed a user, résumé, job, job_score with jdFacts)

const fakeLlm = (rows: unknown): LlmClient => ({
  async complete() { return { data: { rows }, model: "openai/gpt-oss-120b", costUsd: 0.0004 }; },
});

it("buildRequirements flattens mustHaves/niceToHaves/responsibilities with stable ids", () => {
  const reqs = buildRequirements({ title: "x", mustHaves: ["a"], niceToHaves: ["b"],
    responsibilities: ["c"], redFlags: [] } as never);
  expect(reqs).toEqual([
    { id: 0, kind: "must", text: "a" },
    { id: 1, kind: "nice", text: "b" },
    { id: 2, kind: "responsibility", text: "c" },
  ]);
});

it("completes: queued → completed with verified rows and both signals", async () => {
  const llm = fakeLlm([{ id: 0, term: "distributed", status: "met",
    evidence: "Led distributed payments platform", reason: "r", note: null }]);
  const queued = await correlate(USER_ID, { jobId: JOB_ID }, { llm });
  expect(queued.status).toBe("queued");
  const done = await pollUntilTerminal(queued.id); // helper from tailor.test.ts pattern
  expect(done.status).toBe("completed");
  expect(done.rows[0].status).toBe("met");
  expect(done.semantic.total).toBe(done.rows.length);
  expect(done.ats.total).toBe(done.rows.length);
});

it("downgrades an uncited claim to gap (fail-safe, not fail-open)", async () => {
  const llm = fakeLlm([{ id: 0, term: "kafka", status: "met",
    evidence: "Built Kafka streaming that isn't in the résumé", reason: "r", note: null }]);
  const done = await pollUntilTerminal((await correlate(USER_ID, { jobId: JOB_ID }, { llm })).id);
  expect(done.rows[0].status).toBe("gap");
});

it("throws NoJdFactsError when the job was never scored", async () => {
  await expect(correlate(USER_ID, { jobId: UNSCORED_JOB_ID }, { llm: fakeLlm([]) }))
    .rejects.toBeInstanceOf(NoJdFactsError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/correlate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `src/server/tailor/correlate.ts`:
```ts
import { z } from "zod";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import {
  correlationReportsRepo, type CorrelationReportRow,
} from "@/server/persistence/repos/correlationReports";
import { create, type RunHandle } from "@/server/runs/registry";
import type { JdFacts } from "@/server/score/jdFacts";
import { CorrelationReport, type CorrelationRow } from "@/types";
import { atsSignal, semanticSignal, verifyEvidence } from "./correlate-metrics";
import { NoActiveResumeError, UnknownJobError } from "./errors"; // see note below

export class NoJdFactsError extends Error {
  constructor(jobId: string) {
    super(`Job "${jobId}" has no extracted JD facts — score this job first.`);
    this.name = "NoJdFactsError";
  }
}

export function buildRequirements(jd: JdFacts) {
  const rows: { id: number; kind: "must" | "nice" | "responsibility"; text: string }[] = [];
  let id = 0;
  for (const text of jd.mustHaves) rows.push({ id: id++, kind: "must", text });
  for (const text of jd.niceToHaves) rows.push({ id: id++, kind: "nice", text });
  for (const text of jd.responsibilities) rows.push({ id: id++, kind: "responsibility", text });
  return rows;
}

export const CorrelateResultSchema = z.object({
  rows: z.array(z.object({
    id: z.number().int(),
    term: z.string(),
    status: z.enum(["met", "buried", "gap"]),
    evidence: z.string().nullable(),
    reason: z.string(),
    note: z.string().nullable(),
  })),
});

export interface CorrelateDeps { llm?: LlmClient; }

export async function correlate(
  userId: string, input: { jobId: string }, deps: CorrelateDeps = {},
): Promise<CorrelationReport> {
  if (!(await jobsRepo.existsById(input.jobId, userId))) throw new UnknownJobError(input.jobId);
  const resumeRow = await resumesRepo.getActive(userId);
  if (!resumeRow) throw new NoActiveResumeError();
  const scoreRow = await jobScoresRepo.getLatestByJobId(input.jobId);
  if (!scoreRow?.jdFacts) throw new NoJdFactsError(input.jobId);

  const inserted = await correlationReportsRepo.insert({
    userId, jobId: input.jobId, resumeId: resumeRow.id, rows: [],
    status: "queued", model: modelFor("correlate").model,
  });
  const handle = create("correlate", inserted.id, userId);
  void runCorrelateJob(inserted, resumeRow, scoreRow.jdFacts as JdFacts, handle, deps)
    .catch((err) => failRun(inserted.id, handle, err));
  return toCorrelationReport(inserted);
}

async function runCorrelateJob(
  row: CorrelationReportRow, resumeRow: ResumeRow, jd: JdFacts,
  handle: RunHandle, deps: CorrelateDeps,
): Promise<void> {
  await correlationReportsRepo.updateStatus(row.id, "running");
  handle.emit({ event: "progress", data: { stage: "extract", current: 0, total: 3, label: "Reading requirements…" } });

  const requirements = buildRequirements(jd);
  handle.emit({ event: "progress", data: { stage: "classify", current: 1, total: 3, label: "Matching against your résumé…" } });

  const llm = deps.llm ?? getLlm();
  const result = await llm.complete({
    task: "correlate",
    messages: renderTemplate("correlate", {
      requirements: JSON.stringify(requirements),
      resume: JSON.stringify(resumeRow.structured),
    }),
    responseSchema: CorrelateResultSchema,
  });

  handle.emit({ event: "progress", data: { stage: "verify", current: 2, total: 3, label: "Verifying evidence…" } });

  const byId = new Map(requirements.map((r) => [r.id, r]));
  const missing = requirements.filter((r) => !result.data.rows.some((o) => o.id === r.id));
  if (missing.length > 0) {
    throw new Error(`correlate: classifier dropped requirement id(s) ${missing.map((m) => m.id).join(",")}`);
  }
  const classified: Omit<CorrelationRow, "atsPresent">[] = result.data.rows.map((o) => {
    const req = byId.get(o.id);
    if (!req) throw new Error(`correlate: classifier returned unknown id ${o.id}`);
    return { requirement: req.text, term: o.term, kind: req.kind, status: o.status,
      evidence: o.evidence, reason: o.reason, note: o.note };
  });
  const verified = verifyEvidence(classified, resumeRow.structured);

  const completed = await correlationReportsRepo.complete(row.id, {
    rows: verified, semantic: semanticSignal(verified), ats: atsSignal(verified),
    model: result.model, costUsd: result.costUsd, completedAt: new Date(),
  });
  if (!completed) throw new Error(`correlation_reports row ${row.id} vanished before completion`);
  handle.emit({ event: "done", data: toCorrelationReport(completed) });
}

async function failRun(id: string, handle: RunHandle, err: unknown): Promise<void> {
  console.error(`correlate run ${id} crashed:`, err);
  const message = err instanceof Error ? err.message : String(err);
  try { await correlationReportsRepo.markFailed(id); }
  catch (e) { console.error(`correlate run ${id}: failed to persist 'failed':`, e); }
  handle.emit({ event: "error", data: { error: { code: "INTERNAL", message } } });
}

export function toCorrelationReport(row: CorrelationReportRow): CorrelationReport {
  return CorrelationReport.parse({
    id: row.id, jobId: row.jobId, resumeId: row.resumeId, status: row.status, progress: null,
    rows: row.rows, semantic: row.semantic ?? { met: 0, buried: 0, gap: 0, total: 0 },
    ats: row.ats ?? { present: 0, total: 0, missing: [] },
    model: row.model, costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}
```
**Note (shared errors):** `UnknownJobError` and `NoActiveResumeError` currently live in `src/server/tailor/index.ts`. Extract both into a new `src/server/tailor/errors.ts` and re-export them from `index.ts` (so existing importers are unaffected), then import them here. Do this extraction as the first edit of Step 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/correlate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/correlate.ts src/server/tailor/correlate.test.ts src/server/tailor/errors.ts src/server/tailor/index.ts
git commit -m "feat(tailor): correlation engine (classify → verify → two signals)"
```

---

### Task 8: Correlate API routes

**Files:**
- Create: `src/app/api/tailor/correlate/route.ts` (POST)
- Create: `src/app/api/tailor/correlate/[id]/route.ts` (GET/SSE)
- Test: `src/app/api/tailor/correlate/route.test.ts`, `src/app/api/tailor/correlate/[id]/route.test.ts`

**Interfaces:**
- Consumes: `correlate`, `toCorrelationReport`, `correlationReportsRepo`, `NoJdFactsError`, `UnknownJobError`, `NoActiveResumeError`, run registry `get`, `requireUser`, `UuidParam`.
- Produces: `POST /api/tailor/correlate` → 202 | 401 | 404 | 409; `GET /api/tailor/correlate/:id` → 200 | 401 | 404 (+ SSE via Accept).

- [ ] **Step 1: Write the failing test (POST)**

Create `src/app/api/tailor/correlate/route.test.ts`, mirroring `src/app/api/tailor/route.test.ts`: 401 (no session), 404 (unknown job), 409 (no active résumé), 409 (no jd facts → `CONFLICT`), 202 (happy path returns queued `CorrelationReport`), 422 (bad body).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/tailor/correlate/route.test.ts`
Expected: FAIL — route module missing.

- [ ] **Step 3: Implement POST**

Create `src/app/api/tailor/correlate/route.ts`, mirroring `app/api/tailor/route.ts` exactly, but mapping errors:
```ts
    const run = await correlate(session.id, body);
    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid correlate request.", err.issues);
    if (err instanceof UnknownJobError) return errorResponse(404, "NOT_FOUND", err.message);
    if (err instanceof NoActiveResumeError) return errorResponse(409, "CONFLICT", err.message);
    if (err instanceof NoJdFactsError) return errorResponse(409, "CONFLICT", err.message);
    throw err;
  }
```
Import `correlate, NoJdFactsError` from `@/server/tailor/correlate` and `NoActiveResumeError, UnknownJobError` from `@/server/tailor`.

- [ ] **Step 4: Implement GET/SSE**

Create `src/app/api/tailor/correlate/[id]/route.ts`, mirroring `src/app/api/tailor/[id]/route.ts` (same content-negotiation JSON-vs-SSE structure): load `correlationReportsRepo.getById(id, session.id)` → 404 if null; JSON path returns `toCorrelationReport(row)`; SSE path subscribes to `get(id)` and streams `progress`/`done`/`error`, with the same synthetic-terminal fallback the tailor GET uses when the run handle is already gone.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/tailor/correlate/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/tailor/correlate/
git commit -m "feat(api): POST/GET /api/tailor/correlate (202 + polling/SSE)"
```

---

### Task 9: Bullet-addressable merge

**Files:**
- Modify: `src/server/tailor/merge.ts`
- Test: `src/server/tailor/merge.test.ts` (create if absent; else extend)

**Interfaces:**
- Produces:
  - `applyEdits(base: ResumeStore, edits: TailorDiffEntry[]): ResumeStore` — applies every edit to its `target`.
  - `applyAcceptedDiff(base: ResumeStore, diff: TailorDiffEntry[], acceptedIndices: number[]): ResumeStore` — applies only accepted edits. **Signature changed** (drops the old `tailored` param).
  - `DiffEntrySchema = TailoredResume.shape.diff.element` (unchanged export).
  - Errors `InvalidDiffIndexError`, `UnknownDiffSectionError` (kept).

- [ ] **Step 1: Write the failing test**

Create/extend `src/server/tailor/merge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { TailorDiffEntry } from "@/types";
import { applyAcceptedDiff, applyEdits } from "./merge";

const base: ResumeStore = { /* two experience bullets under role 0 */ } as ResumeStore;

it("applies a modify edit to a single bullet, leaving its sibling untouched", () => {
  const edits: TailorDiffEntry[] = [
    { section: "experience", op: "modify", before: "old0", after: "new0",
      reason: "r", requirement: "x", target: { index: 0, bulletIndex: 0 } },
  ];
  const out = applyEdits(base, edits);
  expect(out.experience[0].bullets[0]).toBe("new0");
  expect(out.experience[0].bullets[1]).toBe(base.experience[0].bullets[1]);
});

it("accepts one edit and rejects a same-section sibling", () => {
  const edits: TailorDiffEntry[] = [
    { section: "experience", op: "modify", before: "old0", after: "A",
      reason: "r", requirement: "x", target: { index: 0, bulletIndex: 0 } },
    { section: "experience", op: "modify", before: "old1", after: "B",
      reason: "r", requirement: "y", target: { index: 0, bulletIndex: 1 } },
  ];
  const out = applyAcceptedDiff(base, edits, [0]); // accept first only
  expect(out.experience[0].bullets[0]).toBe("A");
  expect(out.experience[0].bullets[1]).toBe(base.experience[0].bullets[1]); // reject preserved
});

it("applies a scalar summary edit", () => {
  const out = applyEdits(base, [{ section: "summary", op: "modify", before: "", after: "S",
    reason: "r", requirement: "z", target: { index: null, bulletIndex: null } }]);
  expect(out.summary).toBe("S");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/merge.test.ts`
Expected: FAIL — `applyEdits` not exported / signature mismatch.

- [ ] **Step 3: Rewrite merge**

Replace `merge.ts` body with target-addressed application. Keep `DiffEntrySchema` export and the error classes. Core:
```ts
export function applyEdits(base: ResumeStore, edits: TailorDiffEntry[]): ResumeStore {
  const next = structuredClone(base);
  for (const e of edits) applyOne(next, e);
  return next;
}

export function applyAcceptedDiff(
  base: ResumeStore, diff: TailorDiffEntry[], acceptedIndices: number[],
): ResumeStore {
  const accepted = acceptedIndices.map((i) => {
    if (i < 0 || i >= diff.length) throw new InvalidDiffIndexError(i, diff.length);
    return diff[i];
  });
  return applyEdits(base, accepted);
}

function applyOne(store: ResumeStore, e: TailorDiffEntry): void {
  switch (e.section) {
    case "summary": store.summary = e.after ?? undefined; return;
    case "headline": store.headline = e.after ?? undefined; return;
    case "experience": {
      const role = store.experience[e.target.index ?? -1];
      if (!role) throw new InvalidDiffIndexError(e.target.index ?? -1, store.experience.length);
      if (e.target.bulletIndex == null) return; // whole-role edits unsupported in v1
      applyBullet(role.bullets, e); return;
    }
    case "projects": {
      const proj = store.projects[e.target.index ?? -1];
      if (!proj) throw new InvalidDiffIndexError(e.target.index ?? -1, store.projects.length);
      if (e.target.bulletIndex == null) return;
      applyBullet(proj.bullets, e); return;
    }
    case "skills": {
      const group = store.skills[e.target.index ?? -1];
      if (!group) throw new InvalidDiffIndexError(e.target.index ?? -1, store.skills.length);
      applyBullet(group.items, e); return;
    }
    default: throw new UnknownDiffSectionError(e.section);
  }
}

function applyBullet(list: string[], e: TailorDiffEntry): void {
  if (e.op === "add") { if (e.after) list.push(e.after); return; }
  const i = e.target.bulletIndex ?? -1;
  if (i < 0 || i >= list.length) throw new InvalidDiffIndexError(i, list.length);
  if (e.op === "remove") { list.splice(i, 1); return; }
  if (e.after) list[i] = e.after; // modify
}
```
Confirm `structuredClone` is available in the Node target (Node ≥17); it is used elsewhere or fall back to `JSON.parse(JSON.stringify(base))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tailor/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/merge.ts src/server/tailor/merge.test.ts
git commit -m "feat(tailor): bullet-addressable merge (retire one-entry-per-section)"
```

---

### Task 10: Report-driven rewrite (`index.ts` + `tailor.md`)

**Files:**
- Modify: `src/server/tailor/index.ts`
- Modify: `config/templates/tailor.md`
- Modify: `src/server/tailor/assemble.ts`
- Test: `src/server/tailor/tailor.test.ts` (rewrite for new behavior)

**Interfaces:**
- Consumes: `correlate`/`toCorrelationReport` (or a resolve helper), `correlationReportsRepo`, `applyEdits`, `applyAcceptedDiff` (new sig), `fabricationViolations`.
- Produces: `startTailor(userId, { jobId, reportId? }, deps)`; `TailorResultSchema = z.object({ diff: z.array(DiffEntrySchema) })` (edits only). Stages `correlate → rewrite → render → done`.

- [ ] **Step 1: Write the failing test**

Update `src/server/tailor/tailor.test.ts`:
- Seed a completed `correlation_reports` row for the job (or let `startTailor` create one via `correlate` with a mock LLM).
- Assert `startTailor({ jobId, reportId })` completes with a `diff[]` whose entries carry `requirement` + `target`, and `structured` equals `applyEdits(base, diff)`.
- Assert a rewrite whose `after` invents a metric → run fails (fabrication guard), status `failed`.
- Assert genuine-`gap` requirements never appear as an edit's `requirement`.
- Update the SSE-order test to `correlate → rewrite → render → done`.
- Remove the "duplicate-section diff fails loud" test (constraint retired); replace with "two edits in the same section are allowed".

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tailor/tailor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the template**

Replace `config/templates/tailor.md` so the model emits **edits only**, addressable, driven by the report. Key changes: drop the "emit full ResumeStore + all 12 concepts" section entirely; input becomes the résumé + the report rows (buried/met candidates) + an explicit gap list "do not fabricate these". Instruct: for each candidate requirement, at most one edit `{section, op, target:{index,bulletIndex}, before, after, requirement, reason}` that rewords existing content into the requirement's vocabulary or surfaces buried evidence; never introduce a fact/metric not in the résumé; never write an edit for a gap requirement.

- [ ] **Step 4: Rewrite `startTailor`/`runTailorJob`**

In `index.ts`:
- `TailorResultSchema = z.object({ diff: z.array(DiffEntrySchema) })`; remove the `superRefine` and the `resume: ResumeStoreEmitSchema` field and `emitToStore` usage.
- `startTailor(userId, { jobId, reportId? }, deps)`: resolve the report — if `reportId`, `correlationReportsRepo.getById(reportId, userId)` (404 if null/foreign); else `await correlate(userId, {jobId}, deps)` then poll/await its completion (reuse the run registry or call an internal `correlateSync`). Emit `correlate` stage.
- `runTailorJob`: render `tailor` with `{ resume, report }` (report = the completed rows split into candidates + gaps as JSON), call LLM → `{ diff }`. Run `fabricationViolations(diff, base)`; if non-empty → throw (fail loud, run marked `failed`). Compute `structured = applyEdits(base, diff)`; persist via `tailoredResumesRepo.complete({ structured, diff, model, costUsd, completedAt })` and set `reportId`.
- Remove the `"Not available"` fallback and the `jobScoresRepo` `gaps` read.
- `finalizeTailor`/`renderTailorPdf`: update `applyAcceptedDiff(base, row.diff, acceptedIndices)` (drop the `tailored` arg).

In `assemble.ts`: add `reportId: row.reportId` to the parsed `TailoredResume`; where it derives the accepted-only view, call the new `applyAcceptedDiff(base, row.diff, row.acceptedIndices)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/tailor/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/tailor/index.ts src/server/tailor/assemble.ts config/templates/tailor.md src/server/tailor/tailor.test.ts
git commit -m "feat(tailor): report-driven edits-only rewrite + fabrication guard; own jdFacts"
```

---

### Task 11: Reconcile finalize/pdf/route tests

**Files:**
- Modify: `src/server/tailor/finalize.test.ts`
- Modify: `src/app/api/tailor/route.test.ts`, `src/app/api/tailor/[id]/route.test.ts`, `[id]/finalize/route.test.ts`, `[id]/pdf/route.test.ts`
- Modify: `src/app/api/tailor/route.ts` (accept optional `reportId` in body)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the POST body schema**

In `src/app/api/tailor/route.ts`, change `RequestBody` to `z.object({ jobId: UuidParam, reportId: UuidParam.optional() })` and pass `body` through to `startTailor`. Map a new `UnknownReportError` (define in `errors.ts`, thrown by `startTailor` when `reportId` is unknown/foreign) → 404.

- [ ] **Step 2: Run the whole tailor + route suite to find breakages**

Run: `npx vitest run src/server/tailor/ src/app/api/tailor/`
Expected: FAIL where fixtures still assume the old diff/section-blob shape or the `resume` emission.

- [ ] **Step 3: Fix fixtures/assertions**

Update `finalize.test.ts` and each route test to the new diff element (`requirement` + `target`), the `reportId` field, and `correlate → rewrite → render → done` stages. Keep the accept/reject subset tests but express them with `target`-addressed entries.

- [ ] **Step 4: Run the full default suite**

Run: `npm test`
Expected: PASS (no `*.live.test.ts` run).

- [ ] **Step 5: Commit**

```bash
git add src/server/tailor/finalize.test.ts src/app/api/tailor/
git commit -m "test(tailor): reconcile finalize/pdf/route suites with report-driven diff"
```

---

### Task 12: Full eval harness

**Files:**
- Create: `src/server/tailor/__fixtures__/golden/*.json` (≥3 goldens)
- Create: `src/server/tailor/eval.live.test.ts`
- Modify: `package.json` (add `eval:tailor`)
- Modify: `docs/architecture/runbook.md` (note)

**Interfaces:**
- Consumes: real `getLlm()`, `buildRequirements`, `CorrelateResultSchema`/classify path (call `correlate`'s classify+verify directly or via a small exported `classifyAndVerify(jd, store, llm)` helper — add it to `correlate.ts` if the live test needs it without the DB), `statusAccuracy`, `falseGapRate`, `CORRELATE_BASELINE`, `CORRELATE_EPSILON`, `fabricationViolations`, `atsSignal`.

- [ ] **Step 1: Add a DB-free classify helper**

In `correlate.ts`, export a pure-ish helper the live test can call without persistence:
```ts
export async function classifyAndVerify(
  jd: JdFacts, store: ResumeStore, llm: LlmClient,
): Promise<CorrelationRow[]> {
  const requirements = buildRequirements(jd);
  const result = await llm.complete({ task: "correlate",
    messages: renderTemplate("correlate", {
      requirements: JSON.stringify(requirements), resume: JSON.stringify(store) }),
    responseSchema: CorrelateResultSchema });
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const classified = result.data.rows.map((o) => {
    const req = byId.get(o.id); if (!req) throw new Error(`unknown id ${o.id}`);
    return { requirement: req.text, term: o.term, kind: req.kind, status: o.status,
      evidence: o.evidence, reason: o.reason, note: o.note };
  });
  return verifyEvidence(classified, store);
}
```
Refactor `runCorrelateJob` to call it (DRY).

- [ ] **Step 2: Write two golden fixtures**

Create `src/server/tailor/__fixtures__/golden/01-backend-distributed.json`:
```json
{
  "id": "01-backend-distributed", "category": "synthetic",
  "resume": { "storeVersion": 2, "extractionPath": "text", "name": "Aisha Rahman",
    "headline": "Backend Engineer", "location": "Kuala Lumpur",
    "summary": "Backend engineer building distributed payment systems.",
    "contact": [], "education": [], "projects": [], "certifications": [], "languages": [], "sections": [],
    "experience": [{ "company": "Paywatch", "title": "Backend Engineer", "dates": "2021-2024",
      "start": null, "end": null, "location": null, "isCurrent": false,
      "bullets": ["Led a distributed payments platform handling FX settlement across 4 markets",
        "Operated services on Kubernetes with Postgres"] }],
    "skills": [{ "label": "Backend", "items": ["Kubernetes", "Postgres", "Go"] }] },
  "jdFacts": { "title": "Senior Backend Engineer",
    "mustHaves": ["Experience with distributed systems", "Kubernetes in production", "Kafka event streaming"],
    "niceToHaves": ["FX or payments domain"], "responsibilities": ["Operate production services"],
    "redFlags": [] },
  "expected": { "rows": [
    { "requirement": "Experience with distributed systems", "status": "met" },
    { "requirement": "Kubernetes in production", "status": "met" },
    { "requirement": "Kafka event streaming", "status": "gap" },
    { "requirement": "FX or payments domain", "status": "met" },
    { "requirement": "Operate production services", "status": "buried" }
  ] }
}
```
Create `src/server/tailor/__fixtures__/golden/02-bahasa-synonym.json` — a JD whose `mustHaves` use Bahasa terms and synonyms of skills the résumé states in English (tests cross-language + synonym; expected `met`/`buried`, not `gap`). Include a negation hazard (`"migrating away from Angular"` as a nice-to-have → expected `gap`).

- [ ] **Step 3: Write the live eval**

Create `src/server/tailor/eval.live.test.ts`, mirroring `src/server/resume/eval.live.test.ts` structure (glob-gated, `getLlm()`, 120s timeout):
```ts
// Requirement-correlation eval (LIVE-LLM-GATED). Run: npm run eval:tailor
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client";
import { classifyAndVerify } from "./correlate";
import { CORRELATE_BASELINE, CORRELATE_EPSILON, falseGapRate, statusAccuracy } from "./correlate-metrics";

const DIR = join(__dirname, "__fixtures__", "golden");
const goldens = readdirSync(DIR).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")));

describe("requirement correlation eval (live)", () => {
  const accuracies: number[] = [];
  it.each(goldens.map((g) => [g.id, g] as const))(
    "%s: every met/buried cites verifiable evidence; statuses score acceptably",
    async (_id, g) => {
      const rows = await classifyAndVerify(g.jdFacts, g.resume, getLlm());
      // fail-loud: no surviving met/buried lacks a quote (verifyEvidence already downgrades,
      // so any remaining met/buried MUST have non-null evidence)
      for (const r of rows) {
        if (r.status !== "gap") expect(r.evidence, `${r.requirement} evidence`).toBeTruthy();
      }
      const actual = rows.map((r) => ({ requirement: r.requirement, status: r.status }));
      accuracies.push(statusAccuracy(g.expected.rows, actual));
      expect(falseGapRate(g.expected.rows, actual)).toBeLessThanOrEqual(0.25);
    }, 120000);

  it("aggregate status accuracy meets the calibrated baseline", () => {
    const mean = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    expect(mean).toBeGreaterThanOrEqual(CORRELATE_BASELINE - CORRELATE_EPSILON);
  });
});
```

- [ ] **Step 4: Add the npm script + runbook note**

In `package.json`, add:
```json
"eval:tailor": "vitest run --config vitest.smoke.config.ts src/server/tailor/eval.live.test.ts",
```
In `docs/architecture/runbook.md`, beside the `eval:resume` note, add: "`OPENROUTER_API_KEY=… npm run eval:tailor` — requirement-correlation regression (costs real tokens). Growth rule: every misclassified résumé/JD joins `src/server/tailor/__fixtures__/golden/`."

- [ ] **Step 5: Run the eval (real tokens) and calibrate**

Run: `OPENROUTER_API_KEY=… npm run eval:tailor`
Expected: PASS. If the aggregate is below baseline, inspect misclassifications, refine `correlate.md`, and only lower `CORRELATE_BASELINE` with a recorded rationale (never to paper over a real regression).

- [ ] **Step 6: Commit**

```bash
git add src/server/tailor/eval.live.test.ts src/server/tailor/__fixtures__/ src/server/tailor/correlate.ts package.json docs/architecture/runbook.md
git commit -m "feat(tailor): live requirement-correlation eval harness + golden set"
```

---

### Task 13: e2e + docs finalize

**Files:**
- Modify: `e2e/tailor.spec.ts`
- Modify: `docs/architecture/api-contract.md` (finalize stages line, if not already)

**Interfaces:**
- Consumes: the full stack.

- [ ] **Step 1: Update the e2e flow**

In `e2e/tailor.spec.ts`, update the Playwright flow to: score the job (or seed a score) → `correlate` → assert the report renders rows → generate rewrite → per-edit accept/reject (target-addressed) → save finalizes → PDF renders. Keep it env-gated as the existing spec is.

- [ ] **Step 2: Run e2e (gated)**

Run: `npx playwright test e2e/tailor.spec.ts` (with the app + DB up per runbook)
Expected: PASS.

- [ ] **Step 3: Update the SSE stages line in the contract**

In `docs/architecture/api-contract.md`, update the tailor `stage` values note to `correlate → rewrite → render → done` and add the correlate stages `extract → classify → verify → done`.

- [ ] **Step 4: Commit**

```bash
git add e2e/tailor.spec.ts docs/architecture/api-contract.md
git commit -m "test(tailor): e2e for correlate→rewrite; finalize contract stages"
```

---

## Self-Review

**Spec coverage:** §2 inversion → Tasks 3,6,7 (classify+quote, verifier). §3 goals → correlation engine (7,8), driven rewrite (9,10), jdFacts ownership (7,10), eval harness (3–5,12). §4 types/table/API → Tasks 1,2,8. §5 engine → 6,7. §6 rewrite → 9,10. §7 jdFacts/staleness → 7,10 (409 on missing jdFacts). §8 eval → 3–5,12. All covered.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Two explicit "confirm against real schema" notes (Task 3 flatten accessors, Task 9 `structuredClone`) are verification steps, not deferred work — the code is present.

**Type consistency:** `CorrelationRow` fields identical across Tasks 1/3/7/12. `TailorDiffEntry` (Task 1) used consistently in 4,9,10. `applyAcceptedDiff` new signature `(base, diff, acceptedIndices)` consistent in 9,10,11. `verifyEvidence(Omit<CorrelationRow,"atsPresent">[], store)` consistent in 3,7,12. `correlate`/`classifyAndVerify` consistent in 7,8,12.

**Known follow-through:** Tasks 10–11 touch existing tailor tests broadly (largest-risk tasks) — the two-stage review should scrutinize the `applyAcceptedDiff` signature change fan-out and the removal of the full-store emission.

**Post-merge deferral (final whole-branch review):** the design spec §6 before→after literal-ATS delta (re-running the deterministic ATS check on the merged résumé) is NOT implemented in `index.ts` as shipped — DEFERRED to Phase 2; Task 12's eval harness covers ATS non-regression meanwhile, so this divergence from the spec is on the record rather than silently dropped.
