# Résumé extraction v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make résumé extraction role-agnostic and layout-robust by moving `ResumeStore` to a v2 emit/store split with `strict:true` constrained decoding, adding projects/certs/languages/sections, a vision fallback for image-only PDFs, derived metrics, an eval harness, and an English-first reject gate.

**Architecture:** The LLM emits a **required-nullable emit schema** (`ResumeStoreEmitSchema`, `strict:true`) that a deterministic `emitToStore()` normalizes into the **store schema** (`ResumeStoreSchema`, the DB `jsonb` column type + every consumer's input) — the exact emit/normalize pattern `src/server/score/jdFacts.ts` already proves. Store-shape change is a type-coupled big-bang, so Wave 1 lands the schema + every compile-coupled consumer + ingest wiring in one green commit; Waves 2–3 fan out onto disjoint files.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod 4 (`z.toJSONSchema`), Drizzle + Postgres (SQLite dev), `unpdf` (pdf.js) for text + `renderPageAsImage`, `@napi-rs/canvas` for the rasterize backend, OpenRouter (OpenAI-compatible) via `src/lib/llm/client.ts`, Vitest.

## Global Constraints

- **Fail loud, no fallbacks** (fintech rule): validate at boundaries with `Schema.parse`; never default a missing required value to `0`/`""`/`unknown`. The ONE spec-sanctioned exception: a single malformed date atom coerces to `null` (availability), never crashing the whole extraction.
- **Emit schema = every field required, scalars nullable, only `name` required-non-null.** This is WHY v2 exists (gpt-oss-120b drops `.optional()` fields, documented in `jdFacts.ts`). Do NOT "fix" it back to `.optional()`.
- **Layering:** UI → `features/*` → `server/*`; only `server/*` touches DB or LLM. LLM is OpenRouter-only, cheapest viable model per task via `config/models.yml`.
- **Contract is canon:** Zod schemas in `src/types` are the single source of truth. Do not add wire fields without updating `src/types/index.ts`. Do not grow the frozen `ErrorCode` enum — reuse `VALIDATION_ERROR` for the non-English reject.
- **Small surgical diffs, match existing style, no speculative abstractions.** No `Co-Authored-By: Claude` trailer. Commit only when the operator asks (the executing agent commits per-task locally; the operator owns push).
- **Live LLM calls** need `OPENROUTER_API_KEY` (already in `.env` — never read/print/commit it). Run scripts with `npx tsx --env-file=.env …`. Test-double seam: `CALIBER_TEST_DOUBLES=1`. Migrations/scripts: pass `DATABASE_URL` inline (dev-DB drift trap).
- **Metrics-into-scoring is a SEPARATE commit** from extraction (Wave 3), so each effect is separately measurable.
- **Vision cap:** rasterize at most the first 2 pages (matches the 2-page input boundary).
- **storeVersion = 2** and **extractionPath** live INSIDE the `structured` jsonb — no DB column migration.

---

## File Structure

**New files:**
- `src/server/resume/resume-metrics.ts` — `computeResumeMetrics(store)` → deterministic aggregates (Wave 2).
- `src/lib/rasterize.ts` — `rasterizePdfPages(bytes, maxPages)` → PNG buffers via `unpdf.renderPageAsImage` + `@napi-rs/canvas` (Wave 2).
- `src/server/resume/language.ts` — `assertEnglish(text)` fail-loud gate (Wave 2).
- `src/server/resume/reextract.ts` — one-time re-extraction migration over stored `rawText` (Wave 3).
- `src/server/resume/__fixtures__/golden/*.json` + `src/server/resume/eval.live.test.ts` — eval harness v0 (Wave 2).
- `config/templates/resume-extract-vision.md` — vision prompt (Wave 2).

**Modified (by wave):**
- Wave 1: `resume-store.ts`, `lib/resume-render.ts`, `server/tailor/merge.ts`, `server/resume/ingest.ts`, `lib/llm/client.ts`, `lib/llm/models.ts`, `config/models.yml`, `config/templates/resume-extract.md`, + all `ResumeStore` fixtures.
- Wave 2: `server/resume/extract-text.ts`, `lib/pdf-text.ts`, `server/resume/derive-view.ts`, `server/search/roleMatch.ts`, `server/tailor/index.ts`, `config/templates/tailor.md`, `server/resume/atsScore.ts`, `src/types/index.ts` (wire `Resume` + new fields), `server/resume/derive-view.ts` (map new fields), `caliber-ui/compositions/Resume/ResumeView.tsx`, `server/tailor/assemble.ts`.
- Wave 3: `server/score/index.ts`, `server/score/evalScores.ts`, `config/templates/match-score.md`.

---

## Wave 1 — Foundation contract (SEQUENTIAL — blocks everything)

Build the v2 shape first, alone. The store-schema change is type-coupled: `resume-render.ts` and `merge.ts` reference the removed `extras` and will not compile until updated, and every `ResumeStore` test fixture must move to the v2 shape. This whole wave lands as green commits before any Wave 2 fan-out.

### Task 1: v2 `ResumeStore` — emit schema, store schema, `emitToStore()`, and every type-coupled consumer

**Files:**
- Modify: `src/server/resume/resume-store.ts`
- Modify: `src/lib/resume-render.ts` (drop `extras`, handle nullable `label`/education fields)
- Modify: `src/server/tailor/merge.ts` (`MERGEABLE_SECTIONS`: drop `extras`, add new sections)
- Modify: `src/server/resume/ingest.ts` (call with emit schema → `emitToStore`)
- Modify fixtures: `src/server/persistence/repos/__fixtures__/helpers.ts` (`insertResume`), `src/lib/llm/scripted-fixtures.ts` (`RESUME_STORE`), and the inline `ResumeStore` literals in: `src/server/resume/atsScore.test.ts`, `src/server/resume/derive-view.test.ts`, `src/lib/resume-render.test.ts`, `src/server/search/roleMatch.test.ts`, `src/server/tailor/tailor.test.ts`, `src/server/tailor/finalize.test.ts`, `src/server/search/run.test.ts`, `src/server/tracker/tracker.test.ts`, `src/server/resume/migrate-uploads.test.ts`, `src/server/persistence/repos/resumes.test.ts`, and the `app/api/**` route tests that build `structured` literals.
- Test: `src/server/resume/resume-store.test.ts` (NEW)

**Interfaces:**
- Produces:
  - `ResumeStoreSchema` (store, DB `jsonb` type) — fields: `storeVersion: 2`, `extractionPath: "text" | "vision"`, `name: string`, `headline?: string`, `location?: string`, `summary?: string`, `contact: ContactLine[]`, `experience: Experience[]`, `education: Education[]`, `skills: SkillGroup[]`, `projects: Project[]`, `certifications: Certification[]`, `languages: LanguageEntry[]`, `sections: ExtraSection[]`.
  - `ResumeStoreEmitSchema` (LLM json_schema, every field required, scalars nullable except `name`). Does NOT include `extractionPath` (that's stamped by the caller).
  - `emitToStore(emit: ResumeStoreEmit, extractionPath: "text" | "vision"): ResumeStore`.
  - Types `ResumeStore`, `ResumeStoreEmit`, and per-entry types.
- Consumes: nothing (leaf schema module).

- [ ] **Step 1: Write the failing test** — `src/server/resume/resume-store.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ResumeStoreEmitSchema, emitToStore, type ResumeStoreEmit } from "./resume-store";

// A minimal, fully-populated emit object; each test overrides one slice.
function emit(over: Partial<ResumeStoreEmit> = {}): ResumeStoreEmit {
  return ResumeStoreEmitSchema.parse({
    storeVersion: 2,
    name: "Ada Lovelace",
    headline: null,
    location: null,
    summary: null,
    contact: [],
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
    ...over,
  });
}

describe("emitToStore", () => {
  it("maps nullable scalars to undefined and stamps extractionPath + storeVersion", () => {
    const store = emitToStore(emit({ headline: null, location: null, summary: null }), "text");
    expect(store.headline).toBeUndefined();
    expect(store.location).toBeUndefined();
    expect(store.summary).toBeUndefined();
    expect(store.extractionPath).toBe("text");
    expect(store.storeVersion).toBe(2);
  });

  it("round-trips a flat skill list honestly (label:null)", () => {
    const store = emitToStore(emit({ skills: [{ label: null, items: ["Go", "Go", "Rust"] }] }), "text");
    expect(store.skills[0].label).toBeUndefined();
    expect(store.skills[0].items).toEqual(["Go", "Rust"]); // deduped, order-preserved
  });

  it("coerces start/end to YYYY-MM and derives isCurrent from verbatim dates", () => {
    const store = emitToStore(
      emit({
        experience: [
          { company: "X", title: "Eng", dates: "Jan 2021 – Present", start: "2021-01", end: null, location: null, bullets: [] },
        ],
      }),
      "text",
    );
    expect(store.experience[0].start).toBe("2021-01");
    expect(store.experience[0].end).toBeUndefined();
    expect(store.experience[0].isCurrent).toBe(true);
  });

  it("coerces a malformed date atom to null instead of throwing (availability > fail-loud for one atom)", () => {
    const store = emitToStore(
      emit({
        experience: [
          { company: "X", title: "Eng", dates: "sometime", start: "not-a-date", end: "2020", location: null, bullets: [] },
        ],
      }),
      "text",
    );
    expect(store.experience[0].start).toBeUndefined();
    expect(store.experience[0].end).toBeUndefined();
    expect(store.experience[0].isCurrent).toBe(false);
  });

  it("keeps the résumé's own heading for open-tail sections", () => {
    const store = emitToStore(emit({ sections: [{ heading: "Volunteering", items: ["Red Cross"] }] }), "vision");
    expect(store.sections[0]).toEqual({ heading: "Volunteering", items: ["Red Cross"] });
    expect(store.extractionPath).toBe("vision");
  });

  it("emit schema rejects a missing required field (strict shape)", () => {
    expect(() => ResumeStoreEmitSchema.parse({ name: "X" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/server/resume/resume-store.test.ts`
Expected: FAIL — `ResumeStoreEmitSchema` / `emitToStore` not exported.

- [ ] **Step 3: Rewrite `src/server/resume/resume-store.ts`**

```ts
// v2 ResumeStore — the single contract feeding ATS scoring, match-scoring,
// tailoring, derive-view, and the apply-assistant. Two schemas + one
// normalizer, the pattern src/server/score/jdFacts.ts proves: the EMIT
// schema (every field required, scalars nullable) unlocks strict:true
// constrained decoding and forces the model to interrogate every concept;
// emitToStore() deterministically normalizes it into the STORE schema the
// DB jsonb column and every consumer bind to.
import { z } from "zod";

export const ContactLineSchema = z.object({ label: z.string(), value: z.string() });

export const ExperienceEntrySchema = z.object({
  company: z.string(),
  title: z.string(),
  dates: z.string(),
  start: z.string().optional(), // "YYYY-MM" atom, normalized
  end: z.string().optional(), // "YYYY-MM" atom; absent = ongoing OR unparseable — resolve via isCurrent
  isCurrent: z.boolean(),
  location: z.string().optional(),
  bullets: z.array(z.string()),
});

export const EducationEntrySchema = z.object({
  school: z.string(),
  credential: z.string().optional(),
  dates: z.string().optional(),
  details: z.array(z.string()),
});

export const SkillGroupSchema = z.object({ label: z.string().optional(), items: z.array(z.string()) });
export const ProjectSchema = z.object({ name: z.string(), url: z.string().optional(), bullets: z.array(z.string()) });
export const CertificationSchema = z.object({ name: z.string(), issuer: z.string().optional(), year: z.string().optional() });
export const LanguageEntrySchema = z.object({ language: z.string(), proficiency: z.string().optional() });
export const ExtraSectionSchema = z.object({ heading: z.string(), items: z.array(z.string()) });

export const ResumeStoreSchema = z.object({
  storeVersion: z.literal(2),
  extractionPath: z.enum(["text", "vision"]),
  name: z.string(),
  headline: z.string().optional(),
  location: z.string().optional(),
  summary: z.string().optional(),
  contact: z.array(ContactLineSchema),
  experience: z.array(ExperienceEntrySchema),
  education: z.array(EducationEntrySchema),
  skills: z.array(SkillGroupSchema),
  projects: z.array(ProjectSchema),
  certifications: z.array(CertificationSchema),
  languages: z.array(LanguageEntrySchema),
  sections: z.array(ExtraSectionSchema),
});
export type ResumeStore = z.infer<typeof ResumeStoreSchema>;

// EMIT schema (LLM json_schema, strict:true): every field required. Nullable
// audit (Fable): a required NON-nullable scalar on a frequently-absent
// concept invites fabrication — so every legitimately-absent scalar is
// nullable; only `name` is required-non-null. `extractionPath` is NOT emitted
// (the caller stamps it); `isCurrent` is derived by emitToStore, not emitted.
const ExperienceEmitSchema = z.object({
  company: z.string(),
  title: z.string(),
  dates: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  location: z.string().nullable(),
  bullets: z.array(z.string()),
});
const EducationEmitSchema = z.object({
  school: z.string(),
  credential: z.string().nullable(),
  dates: z.string().nullable(),
  details: z.array(z.string()),
});
const SkillGroupEmitSchema = z.object({ label: z.string().nullable(), items: z.array(z.string()) });
const ProjectEmitSchema = z.object({ name: z.string(), url: z.string().nullable(), bullets: z.array(z.string()) });
const CertificationEmitSchema = z.object({ name: z.string(), issuer: z.string().nullable(), year: z.string().nullable() });
const LanguageEmitSchema = z.object({ language: z.string(), proficiency: z.string().nullable() });

export const ResumeStoreEmitSchema = z.object({
  storeVersion: z.literal(2),
  name: z.string(),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
  contact: z.array(ContactLineSchema),
  experience: z.array(ExperienceEmitSchema),
  education: z.array(EducationEmitSchema),
  skills: z.array(SkillGroupEmitSchema),
  projects: z.array(ProjectEmitSchema),
  certifications: z.array(CertificationEmitSchema),
  languages: z.array(LanguageEmitSchema),
  sections: z.array(ExtraSectionSchema),
});
export type ResumeStoreEmit = z.infer<typeof ResumeStoreEmitSchema>;

const CURRENT_RE = /present|current|now|ongoing/i;
const YYYY_MM_RE = /^\d{4}-\d{2}$/;

// Coerce an LLM-emitted date atom to a strict "YYYY-MM" or undefined. NEVER
// throws — a single malformed atom is a normalized miss (availability), not a
// whole-extraction crash (Global Constraints exception).
function coerceMonth(atom: string | null): string | undefined {
  if (atom === null) return undefined;
  const trimmed = atom.trim();
  if (YYYY_MM_RE.test(trimmed)) return trimmed;
  const yearOnly = /^(\d{4})$/.exec(trimmed);
  if (yearOnly) return `${yearOnly[1]}-01`;
  return undefined;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

const clean = (v: string | null): string | undefined => {
  if (v === null) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

export function emitToStore(emit: ResumeStoreEmit, extractionPath: "text" | "vision"): ResumeStore {
  const store: ResumeStore = {
    storeVersion: 2,
    extractionPath,
    name: emit.name.trim(),
    headline: clean(emit.headline),
    location: clean(emit.location),
    summary: clean(emit.summary),
    contact: emit.contact.map((c) => ({ label: c.label.trim(), value: c.value.trim() })).filter((c) => c.value.length > 0),
    experience: emit.experience.map((e) => ({
      company: e.company.trim(),
      title: e.title.trim(),
      dates: (e.dates ?? "").trim(),
      start: coerceMonth(e.start),
      end: coerceMonth(e.end),
      isCurrent: CURRENT_RE.test(e.dates ?? ""),
      location: clean(e.location),
      bullets: e.bullets.map((b) => b.trim()).filter(Boolean),
    })),
    education: emit.education.map((ed) => ({
      school: ed.school.trim(),
      credential: clean(ed.credential),
      dates: clean(ed.dates),
      details: ed.details.map((d) => d.trim()).filter(Boolean),
    })),
    skills: emit.skills.map((g) => ({ label: clean(g.label), items: dedupe(g.items) })).filter((g) => g.items.length > 0),
    projects: emit.projects.map((p) => ({ name: p.name.trim(), url: clean(p.url), bullets: p.bullets.map((b) => b.trim()).filter(Boolean) })),
    certifications: emit.certifications.map((c) => ({ name: c.name.trim(), issuer: clean(c.issuer), year: clean(c.year) })),
    languages: emit.languages.map((l) => ({ language: l.language.trim(), proficiency: clean(l.proficiency) })),
    sections: emit.sections.map((s) => ({ heading: s.heading.trim(), items: s.items.map((i) => i.trim()).filter(Boolean) })).filter((s) => s.items.length > 0),
  };
  return ResumeStoreSchema.parse(store);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/resume/resume-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Fix `resume-render.ts` (compile-breaker: `extras` removed, `label` nullable)**

In `src/lib/resume-render.ts` — replace the `skillsHtml`, `educationHtml`, and `extrasHtml` blocks. Skills group heading only when present; education credential/dates guarded; drop the `extras` section (its content now lives in `sections[]` — render those instead), and render nothing for empty new arrays:

```ts
  const educationHtml = store.education
    .map((ed) => {
      const parts = [ed.credential, ed.school].filter(Boolean).map((s) => escapeHtml(s as string)).join(", ");
      const dates = ed.dates ? ` (${escapeHtml(ed.dates)})` : "";
      return `<li>${parts}${dates}</li>`;
    })
    .join("");

  const skillsHtml = store.skills
    .map(
      (g) => `<div class="skill-group">
  ${g.label ? `<h4>${escapeHtml(g.label)}</h4>` : ""}
  <p>${g.items.map(escapeHtml).join(", ")}</p>
</div>`,
    )
    .join("");

  const sectionsHtml = store.sections
    .map(
      (s) => `<section class="extra-section">
  <h4>${escapeHtml(s.heading)}</h4>
  <ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
</section>`,
    )
    .join("");
```

Update the returned HTML: `summary` is now optional (`store.summary ? … : ""`), replace `<section class="extras">…` with `<section class="sections">${sectionsHtml}</section>`. Full new-section rendering (projects/certs/languages) lands in Wave 2 Task 7 — for Wave 1 the goal is compile-green + no data loss regression, so also render projects/certs/languages minimally if trivial, else defer to Task 7 and keep them out of the render (they are new arrays, absence is not a regression).

- [ ] **Step 6: Fix `merge.ts` (compile-breaker: `extras` is no longer a `keyof ResumeStore`)**

In `src/server/tailor/merge.ts`, update `MERGEABLE_SECTIONS`:

```ts
const MERGEABLE_SECTIONS = new Set<keyof ResumeStore>([
  "name",
  "headline",
  "summary",
  "contact",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "languages",
  "sections",
]);
```

- [ ] **Step 7: Wire `ingest.ts` to emit→store**

In `src/server/resume/ingest.ts`: import `ResumeStoreEmitSchema, emitToStore` (drop `ResumeStoreSchema` import if now unused for the call). Change the `llm.complete` call to use the emit schema and normalize:

```ts
    const result = await llm.complete({
      task: "resume-extract",
      messages: renderTemplate("resume-extract", { rawText }),
      responseSchema: ResumeStoreEmitSchema,
    });
    structured = emitToStore(result.data, "text");
```

(The vision branch + English gate arrive in Wave 2 Task 5; Wave 1 keeps ingest text-only.)

- [ ] **Step 8: Migrate every `ResumeStore` fixture to v2**

Update the two central fixtures first, then the inline literals. Every fixture must gain `storeVersion: 2`, `extractionPath: "text"`, `projects: []`, `certifications: []`, `languages: []`, rename `extras: [...]` → `sections: []` (move any content into `{heading, items}` form), add `isCurrent: false` (or `true` for "Present" roles) + optional `start`/`end` to each experience entry, and make `education` entries use `details: []`.

- `src/server/persistence/repos/__fixtures__/helpers.ts` `insertResume` — the `structured: {…}` literal.
- `src/lib/llm/scripted-fixtures.ts` `RESUME_STORE` — this is the mock `resume-extract` **emit** output now (it flows through `emitToStore`); reshape to the emit schema (required-nullable) if it feeds `deps.llm`. Verify against how `ingest`/mock consume it.
- Inline literals in the test files listed under **Files** above.

- [ ] **Step 9: Run the full suite + typecheck to verify green**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (all ~1055 + 6 new). Fix any remaining fixture that still uses v1 shape.

- [ ] **Step 10: Commit**

```bash
git add src/server/resume/resume-store.ts src/server/resume/resume-store.test.ts src/lib/resume-render.ts src/server/tailor/merge.ts src/server/resume/ingest.ts src/server/persistence/repos/__fixtures__/helpers.ts src/lib/llm/scripted-fixtures.ts src/**/*.test.ts src/**/*.test.tsx
git commit -m "feat(resume): v2 ResumeStore emit/store split + emitToStore normalizer"
```

### Task 2: `client.ts` `strict:true` opt-in + `additionalProperties:false` hardener; `models.ts` strict flag

**Files:**
- Modify: `src/lib/llm/client.ts`
- Modify: `src/lib/llm/models.ts`
- Test: `src/lib/llm/client.test.ts`, `src/lib/llm/models.test.ts`

**Interfaces:**
- Consumes: `modelFor(task)` gains an optional `strict?: boolean`.
- Produces: when a task's config sets `strict: true`, `client.ts` sends `response_format.json_schema.strict = true` and recursively injects `additionalProperties: false` into every object node of the derived JSON schema (OpenAI strict mode requires it). Non-strict tasks are unchanged (`strict:false`, no hardening).

- [ ] **Step 1: Write the failing test** — add to `src/lib/llm/client.test.ts`

```ts
it("sends strict:true and stamps additionalProperties:false on every object node when the task opts in", async () => {
  const captured: any[] = [];
  const transport = fakeTransport((body) => captured.push(body)); // reuse the file's existing transport double
  const client = buildClientForTest(transport); // whatever the test file already uses
  await client.complete({
    task: "resume-extract", // config sets strict:true in models.yml (Task 3)
    messages: [{ role: "user", content: "hi" }],
    responseSchema: z.object({ a: z.object({ b: z.string() }) }),
  });
  const rf = captured[0].response_format.json_schema;
  expect(rf.strict).toBe(true);
  expect(rf.schema.additionalProperties).toBe(false);
  expect(rf.schema.properties.a.additionalProperties).toBe(false);
});
```

(Match the existing test file's transport-doubling style — read `client.test.ts` first and mirror it rather than importing a new harness.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/llm/client.test.ts`
Expected: FAIL — `strict` is hard-coded `false`.

- [ ] **Step 3: Implement the hardener + strict opt-in in `client.ts`**

Add a recursive hardener above `buildClient`:

```ts
// OpenAI strict mode requires additionalProperties:false on every object node.
function harden(node: unknown): void {
  if (Array.isArray(node)) {
    for (const n of node) harden(n);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") obj.additionalProperties = false;
    for (const v of Object.values(obj)) harden(v);
  }
}
```

In `complete`, after `const jsonSchema = …`, read the strict flag and conditionally harden:

```ts
      const strict = config.strict === true;
      if (strict) harden(jsonSchema);
      // …
          response_format: {
            type: "json_schema",
            json_schema: { name: task, schema: jsonSchema, strict },
          },
```

`config` is `modelFor(task)` — extend its return to carry `strict`.

- [ ] **Step 4: Add the `strict` flag to `models.ts`**

`RawTaskConfig` gains `strict?: boolean`; `modelFor` returns `…, ...(strict !== undefined ? { strict } : {})`. Add a `models.test.ts` case asserting `modelFor("resume-extract").strict === true` after Task 3.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/lib/llm/client.test.ts src/lib/llm/models.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/client.ts src/lib/llm/client.test.ts src/lib/llm/models.ts src/lib/llm/models.test.ts
git commit -m "feat(llm): strict:true opt-in + additionalProperties hardener for constrained decoding"
```

### Task 3: `config/models.yml` — maxTokens, strict, vision task + price

**Files:**
- Modify: `config/models.yml`
- Test: `src/lib/llm/models.test.ts`

**Interfaces:**
- Produces: `resume-extract` gains `maxTokens: 8000` + `strict: true`; `tailor` gains `maxTokens: 12000` + `strict: true`; new task `resume-extract-vision` (model `mistralai/mistral-small-3.2-24b-instruct`, `maxTokens: 8000`, `temperature: 0.1`, `strict: true`); new price row for the mistral model. `resume-extract-vision` must be added to the `TaskName` union in `client.ts`.

- [ ] **Step 1: Write the failing test** — add to `models.test.ts`

```ts
it("routes resume-extract-vision to mistral-small with strict + a price row", () => {
  const cfg = modelFor("resume-extract-vision");
  expect(cfg.model).toBe("mistralai/mistral-small-3.2-24b-instruct");
  expect(cfg.strict).toBe(true);
  expect(cfg.maxTokens).toBe(8000);
  expect(() => priceFor("mistralai/mistral-small-3.2-24b-instruct")).not.toThrow();
});

it("resume-extract now budgets 8000 tokens with strict decoding", () => {
  const cfg = modelFor("resume-extract");
  expect(cfg.maxTokens).toBe(8000);
  expect(cfg.strict).toBe(true);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run src/lib/llm/models.test.ts`
Expected: FAIL — unknown task / wrong maxTokens.

- [ ] **Step 3: Edit `config/models.yml`**

Under `tasks:` set `resume-extract.maxTokens: 8000` + add `strict: true`; set `tailor.maxTokens: 12000` + add `strict: true`; add:

```yaml
  resume-extract-vision:
    model: mistralai/mistral-small-3.2-24b-instruct
    maxTokens: 8000
    temperature: 0.1
    reasoningEffort: low
    strict: true
```

Under `prices:` add (confirm exact per-MTok rates from OpenRouter during impl — the $0.00043/résumé figure is the bake-off single-page cost):

```yaml
  mistralai/mistral-small-3.2-24b-instruct: { promptUsdPerMTok: 0.05, completionUsdPerMTok: 0.10 }
```

- [ ] **Step 4: Add `"resume-extract-vision"` to `TaskName` in `src/lib/llm/client.ts`.**

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/lib/llm/models.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/models.yml src/lib/llm/models.test.ts src/lib/llm/client.ts
git commit -m "feat(models): resume-extract 8000+strict, tailor bump, resume-extract-vision task"
```

### Task 4: Rewrite `config/templates/resume-extract.md`

**Files:**
- Modify: `config/templates/resume-extract.md`
- Test: `src/lib/llm/templates.test.ts` (assert the new blocks render; no live call here)

**Interfaces:** Consumes `{{rawText}}`. Produces a prompt that: maps sections by MEANING not heading name (synonym map); reassembles column-scrambled fragments; defines `headline` as a SHORT role line (null if absent — never the summary); `name` = the person only (strip trailing credentials like ", PMP"); instructs all 12 concepts including projects/certifications/languages and an open-tail `sections[]` keyed by the résumé's own headings; emits `start`/`end` as `YYYY-MM` atoms where derivable.

- [ ] **Step 1: Write the failing test** — assert the rendered system+user text contains the load-bearing instructions (e.g. `/headline/i`, `/YYYY-MM/`, `/certifications/i`, `/sections/i`).

- [ ] **Step 2: Run to confirm fail.** Run: `npx vitest run src/lib/llm/templates.test.ts` → FAIL.

- [ ] **Step 3: Rewrite the template** (`--- system ---` + `--- user:instructions ---` + `--- user:candidate ---`). Include: the concept list; the section-synonym guidance ("'Work History'/'Employment'/'Experience' all → experience; 'Tech Stack'/'Technical Skills'/'Competencies' → skills; …"); de-scramble instruction for 2-column PDFs; `name` = person-only; `headline` = short current/target role line or null; date-atom instruction; "put anything that doesn't fit a first-class concept into `sections[]` with its verbatim heading". Keep "Return ONLY JSON matching the provided schema."

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run src/lib/llm/templates.test.ts` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(resume): v2 extraction prompt — map-by-meaning, de-scramble, 12 concepts"`

### Wave 1 GATE (before any Wave 2 fan-out)

- [ ] Full suite + typecheck + contract:check + build all green: `npx vitest run && npx tsc --noEmit && npm run contract:check && npm run build`
- [ ] **Live smoke** (needs `OPENROUTER_API_KEY`): a throwaway `npx tsx --env-file=.env` script that runs `ingestResume`-equivalent text extraction on **SampleA** (`/Users/hakeem/Downloads/redacted-resume.pdf`) and **SampleB** (`/Users/hakeem/Downloads/REDACTED_NAME CV.pdf`) and asserts: parses clean under strict; SampleA's flat skills round-trip (`label` undefined, items non-empty); SampleB's PMP + Google certs land in `certifications`, 4 languages in `languages`, name has no trailing credential. Do NOT commit the script.

Only proceed to Wave 2 once the gate passes.

---

## Wave 2 — Independent modules (PARALLEL, after the Wave 1 gate)

Disjoint files; dispatch concurrently. Each task is TDD, medium effort, small surgical diff.

### Task 5: Vision branch + English-first reject gate

**Files:**
- Create: `src/lib/rasterize.ts` + `src/lib/rasterize.test.ts`
- Create: `src/server/resume/language.ts` + `src/server/resume/language.test.ts`
- Create: `config/templates/resume-extract-vision.md`
- Modify: `src/lib/pdf-text.ts` (expose low-text instead of only throwing), `src/server/resume/extract-text.ts` (return a discriminated text-or-empty result for PDFs), `src/server/resume/ingest.ts` (route to vision below ~400 chars; English gate; stamp `extractionPath: "vision"` + a review nudge), `src/lib/llm/client.ts` (allow image content parts on a message)
- Add dep: `@napi-rs/canvas`

**Interfaces:**
- `rasterizePdfPages(bytes: Uint8Array, maxPages: number): Promise<Buffer[]>` — PNG buffers via `unpdf.renderPageAsImage` (needs `@napi-rs/canvas`); caps at `maxPages` (2).
- `assertEnglish(text: string): void` — throws `NonEnglishResumeError` when the text is substantially non-English; passes English through.
- `ingest.ts`: text below ~400 chars → rasterize (≤2 pages) → `llm.complete({ task: "resume-extract-vision", … , images })` → `emitToStore(data, "vision")`. Non-English → `NonEnglishResumeError` (route maps to 422 `VALIDATION_ERROR` with a clear "not yet supported" message).

**Design notes for the builder:**
- The current `pdf-text.ts` throws below 20 chars. Restructure so the caller can distinguish "usable text" from "too little text → try vision" WITHOUT losing the corrupt-PDF `PdfParseError` (that must still throw). Suggested: `extractPdfText` returns `{ text: string }` and lets `extract-text.ts`/`ingest.ts` apply the ~400-char routing threshold; keep the hard `PdfParseError` for unreadable bytes.
- `client.ts` `LlmMessage.content` is `string` today. Add an optional image path (e.g. accept `images?: string[]` of data-URIs on the `complete` args, or widen a message's content to OpenAI content-parts). Keep the text path byte-identical.
- Confirm `strict` actually holds for `mistral-small` during impl (bake-off asserted the design, not the flag). If it 400s under strict, fall back to `strict:false` for the vision task ONLY and rely on `emitToStore`/`.parse` — note it in the spec.
- English gate: dependency-free heuristic is acceptable (non-Latin-script ratio + English function-word hit-rate). Reject loudly; the 3 samples are English and must pass. Apply to `rawText` on the text path and to the emitted store's concatenated strings on the vision path.

- [ ] Standard TDD cycle per module (test → fail → implement → pass → commit). Tests: `rasterize` produces ≥1 PNG for `tiny.pdf`, caps at 2; `assertEnglish` passes an English blurb and throws on a CJK/Bahasa blurb; ingest routes a <400-char PDF to the vision task (mock LLM asserts `task: "resume-extract-vision"` was called); ingest rejects a non-English paste.
- [ ] Commit each module separately (`feat(resume): rasterize`, `feat(resume): english-first reject`, `feat(resume): vision fallback for image-only PDFs`).

### Task 6: derive-view headline precedence + relaxed fresh-grad gate + roleMatch dedupe

**Files:**
- Modify: `src/server/resume/derive-view.ts`, `src/server/search/roleMatch.ts`
- Test: `src/server/resume/derive-view.test.ts`, `src/server/search/roleMatch.test.ts`

**Interfaces:**
- `deriveHeadline` precedence becomes: `store.headline` → contact-regex → `experience[0].title` → `education[0]` (credential/school). `deriveLocation`: add `education[0]`/contact fallbacks. `assertResumeViewDerivable` must ACCEPT an education-only fresh-grad résumé (no experience, no title contact line) instead of throwing `ParseFailedError`.
- `roleMatch.deriveRoleTargets`: use `store.headline` first, then the existing precedence; delete the duplicated `HEADLINE_LABEL_RE` regex now that `store.headline` exists.

- [ ] TDD: add a fresh-grad fixture (education only) → asserts a derivable headline/location + no throw; assert `store.headline` wins when present. Then implement. Commit `feat(resume): headline precedence via store.headline + relaxed fresh-grad gate`.

### Task 7: Tailor ripple + wire `Resume` new fields + read-only UI

**Files:**
- Modify: `src/server/tailor/index.ts` (`TailorResultSchema.resume` → `ResumeStoreEmitSchema`; normalize via `emitToStore(_, "text")` after the call), `config/templates/tailor.md` (new sections in the shape), `src/lib/resume-render.ts` (render projects/certs/languages fully), `src/server/tailor/assemble.ts` (map new fields into the wire view), `src/types/index.ts` (add `projects`/`certifications`/`languages` to wire `Resume`), `src/server/resume/derive-view.ts` (`toResumeView` maps the new fields), `src/caliber-ui/compositions/Resume/ResumeView.tsx` (read-only display of the new sections)
- Test: the touched modules' tests + `src/types/index.test.ts`

**Interfaces:**
- Wire `Resume` gains: `projects: {name, url?, bullets}[]`, `certifications: {name, issuer?, year?}[]`, `languages: {language, proficiency?}[]`. `TailoredResume.resume = Resume.omit({id, rawText})` ripples automatically — `assemble.ts` must supply the new fields. `toResumeView` maps them from the store.
- This is the human-verification loop closer: the vision-path review nudge (Task 5) points here.

- [ ] TDD each edit; keep the UI a minimal read-only render (Tag list for languages/certs, a small projects list). Commit `feat(resume): tailor + wire Resume carry projects/certs/languages; read-only UI`.

**Sequencing caution:** Task 7 changes the wire `Resume` type — every `Resume`-shaped test fixture (there are several) needs the three new arrays. Coordinate with whoever else is editing `src/types`; if two Wave-2 tasks both touch `src/types/index.ts`, serialize them.

### Task 8: `computeResumeMetrics` + richer `atsScore`

**Files:**
- Create: `src/server/resume/resume-metrics.ts` + `src/server/resume/resume-metrics.test.ts`
- Modify: `src/server/resume/atsScore.ts` + `src/server/resume/atsScore.test.ts`

**Interfaces:**
- `computeResumeMetrics(store: ResumeStore): { totalYearsExperience, currentTenureMonths, roleCount, avgTenureMonths, distinctSkillCount, certificationCount, languageCount, quantifiedBulletRatio }` — deterministic, no LLM, fed by the `start`/`end`/`isCurrent` atoms; `totalYearsExperience` overlap-merged across roles.
- `quantifiedBulletRatio` = fraction of experience+project bullets containing a digit or a `%`/`$`/currency token. `atsScore` folds `quantifiedBulletRatio` + cert/language presence into the score.

- [ ] TDD: overlap-merge (two overlapping roles don't double-count years); `currentTenureMonths` uses `isCurrent`; `quantifiedBulletRatio` counts "Grew revenue 40%" but not "Led the team". NO LLM. Commit `feat(resume): computeResumeMetrics + quantified-bullet ATS signal`.
- **Do NOT wire metrics into match-scoring here** — that is Wave 3 Task 12, a separate commit (Global Constraints).

### Task 9: Eval harness v0 (the keystone)

**Files:**
- Create: `src/server/resume/__fixtures__/golden/*.json` (10–15 labeled `ResumeStore` fixtures — start with the 3 samples + fresh-grad + image-only + table-heavy + classic single-column), `src/server/resume/eval.live.test.ts`
- Modify: package scripts / CI config to run behind a live-LLM env flag and trigger on edits to `config/templates/resume-extract*.md`, `resume-store.ts`, `config/models.yml`

**Interfaces:** A vitest suite (skipped unless the live-LLM env flag is set) that runs real extraction over each golden `rawText` and asserts: **per-concept presence precision/recall** (all certs/languages/projects found), fuzzy bullet match, exact scalar + date-atom match, and a **containment check** (every extracted value fuzzy-appears in `rawText` — the text-path hallucination guardrail). Assert aggregate ≥ committed baseline − ε (threshold, not exact). ~$0.005/run.

- [ ] Build the fixture set + metrics harness; commit fixtures and harness. Wire the CI trigger. Growth rule (document in the test header): every résumé that fails in prod joins the set.

### Task 10: Telemetry — one log line per extraction

**Files:**
- Modify: `src/server/resume/ingest.ts` (emit one structured log line after `emitToStore`)

**Interfaces:** One log line per extraction: field null-rates (which optional scalars were absent) + the `sections[]` headings + `extractionPath`. This is the drift radar + concept-promotion signal.

- [ ] TDD (spy on the logger); commit `feat(resume): extraction telemetry — null-rates + sections headings`.

---

## Wave 3 — Dependent wiring (after Wave 2, each its own commit)

### Task 11: Metrics → match-score prompt

**Files:**
- Modify: `src/server/score/index.ts` (compute metrics from `resume.structured`, pass into `scoreMatch`), `src/server/score/evalScores.ts` (`scoreMatch` accepts `metrics`), `config/templates/match-score.md` (new `{{metrics}}` block — numeric ground truth so the LLM doesn't miscount years)
- Test: `src/server/score/evalScores.test.ts`, `scoreJob.test.ts`

**Interfaces:** `scoreMatch(llm, { jdFacts, resume, metrics }, modelOverride?)`. `index.ts` lines 75 & 82 (`const cheap`/`const strong`) pass `metrics: computeResumeMetrics(resume.structured)`. Template renders metrics as JSON ground truth.

- [ ] TDD; **its own commit** (`feat(score): feed résumé metrics into match-score as ground truth`) — kept separate from extraction so the scoring effect is measurable.

### Task 12: Re-extraction migration

**Files:**
- Create: `src/server/resume/reextract.ts` + `src/server/resume/reextract.test.ts` (mirror `migrate-uploads.ts`: module-main guard, per-row tolerance, idempotent on `storeVersion === 2`)

**Interfaces:** `reextractResumes(db, llm): Promise<{ migrated, skipped, failed }>` — for each row whose `structured.storeVersion !== 2`, re-run v2 extraction over the stored `rawText` (NOT an SQL heading-fold), re-derive atsScore, write back `structured`. Do BOTH `resumes.structured` and `tailored_resumes.structured` columns. Run with `DATABASE_URL` inline.

- [ ] TDD the row-selection + idempotency with a mock LLM; commit `feat(resume): v1→v2 re-extraction migration from stored rawText`. Operator runs the live migration (trivial volume, app still dark).

---

## Wave 4 — Adversarial review + end-to-end

### Task 13: Design/correctness review

- [ ] Run the `code-review` skill (or `superpowers:requesting-code-review`) over each wave's diff. For deep design/correctness, dispatch a `deep-thinker` (Fable, high effort) READ-ONLY reviewer per wave. Reviewers must NOT write repo files; `git status` after each fan-out.

### Task 14: End-to-end smoke (the eval harness is the real gate)

- [ ] Use the `verify` project skill to drive the app: extract all 3 résumés (SampleA/SampleB via text, **Syed via vision**) → scan jobs → update job **sources** for the roles present (mobile dev, PM/UX) if the current sources don't cover them. This is a smoke check; the eval harness (Task 9) is the quality gate.

---

## Self-Review

**Spec coverage** (each spec section → task):
- v2 schema + emit/store split + `strict:true` → Tasks 1, 2, 3. ✓
- Prompt rewrite (map-by-meaning, de-scramble, headline, name) → Task 4. ✓
- maxTokens 8000 + tailor bump → Task 3. ✓
- Relaxed derivability gate (fresh grads) → Task 6. ✓
- Tailor/render ripple + drop `extras` → Tasks 1 (compile), 7 (full). ✓
- `computeResumeMetrics` (separate scoring commit) → Task 8 (compute) + Task 11 (wire). ✓
- Vision fallback (mistral-small, path marker + review nudge, 2-page cap, ~400-char threshold) → Tasks 3, 5, 7. ✓
- Minimal read-only UI → Task 7. ✓
- English-first detect/reject → Task 5. ✓
- Eval harness v0 → Task 9. ✓
- `sections[]`/null-rate telemetry → Task 10. ✓
- `storeVersion` + re-extraction migration → Tasks 1, 12. ✓
- Scaling section (required-nullable, open-tail `sections[]`, versioning, no confidence routing) → structurally embedded in Tasks 1, 9, 12. ✓
- Coverage boundaries (English-first, >12k reject, vision 2-page cap) → Global Constraints + Tasks 5. ✓

**Deferred (YAGNI) — confirmed NOT in any task:** per-skill proficiency, typed contact enums, awards/publications as first-class, coordinate-based PDF parsing, editable UI, multilingual extraction, dual-model vision agreement, confidence routing, seniority/domain tags. ✓

**Type consistency:** `ResumeStoreEmitSchema`/`emitToStore`/`ResumeStore` names are stable across Tasks 1, 5, 7, 8, 11, 12. `strict` flag name stable across Tasks 2, 3. `computeResumeMetrics` signature stable across Tasks 8, 11. `extractionPath` stamped in Task 1 (`"text"`), overridden `"vision"` in Task 5. ✓

**Known risk flagged for the builder:** Wave 1 Task 1 is a big-bang fixture migration (~15 files). Two Wave-2 tasks (7) touch `src/types/index.ts` — serialize any `src/types` edits. Confirm `strict` holds for `mistral-small` at impl time (Task 5).
