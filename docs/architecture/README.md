# Caliber MVP — Architecture (index)

Date: 2026-07-11. Scope: the five-feature MVP spine. Ties together the three design docs in this folder and records the decisions/corrections that emerged while designing them. The product design lives in `../superpowers/specs/2026-07-11-caliber-standalone-design.md`; this folder is the *how* for the MVP.

## The MVP spine (five features)
1. **F1** Upload résumé (PDF/DOCX/paste) → parsed structured résumé.
2. **F2** On upload, search **both** global/remote ATS **and** Malaysia-local boards, scored against the résumé → the feed.
3. **F3** Apply → open the job's canonical posting URL directly (external).
4. **F4** Application-question assistant → extract a posting's form questions, draft résumé-grounded answers.
5. **F5** Mark applied → an "Applied" button persists into the tracker.
6. **F6** Per-job résumé tailoring → alter the résumé to match a job (diff-review + PDF).

## The pieces, connected
```
UI (Storybook / app)
  └─ features/*  (typed service calls; status-map, feed assembly)
       └─ server/*  (the ONLY layer touching DB or LLM)
            ├─ resume        F1 ingest, F6 render      (lifts pdf-text, resume-render)
            ├─ search        F2 dual discovery          (source-connector abstraction)
            ├─ score         F2 scoring + legitimacy     (rebuilds run-staged eval)
            ├─ apply-assistant F4 questions + answers    (lifts apply-form DOM walk)
            ├─ tailor        F6 tailored résumé          (OpenRouter → ResumeStore JSON)
            ├─ tracker       F5 applications             (4-stage status map)
            └─ persistence   Drizzle (Postgres / SQLite dev)
       lib/llm  → OpenRouter client + config/models.yml + versioned templates
```
Contract flows one way: **Zod schemas in `src/types` → OpenAPI (`contract/openapi.json`) → Scalar docs at `/api/docs`**. UI, services, and routes all import the same `z.infer` types; there is no second type system.

## Documents
- **[system-architecture.md](./system-architecture.md)** — data model (Drizzle tables), service boundaries, the source-connector abstraction, end-to-end flows, hard problems, upfront decisions.
- **[api-contract.md](./api-contract.md)** — endpoint table, core Zod schemas, per-endpoint I/O, SSE shape, OpenAPI/client generation.
- **[component-inventory.md](./component-inventory.md)** — MVP compositions + pages, the F4 question-assistant UX, F6 diff-review, the Storybook story tree.
- **[runbook.md](./runbook.md)** — prerequisites to run the real (non-mocked) app: env vars, migrate/seed, model ids, Playwright install.

## Reconciliations & spec corrections (grounded in reading the donor)
These override the earlier spec where noted:
- **No `scan_jobs` DB table exists in the donor** — scan state lives in `scan-history.tsv` (file plane). Spec §6's "lifts directly" was wrong; the no-file-plane rule (§3) wins → we create a `jobs` table from the TSV columns.
- **No separate `verdict/verdict.ts` module** — legitimacy (Block G) lives *inside* the eval scoring (`compose-report.ts`), so `server/score` owns it.
- **Donor rejects `.docx`** — we add `mammoth` for DOCX ingestion.
- **LaTeX dropped** — tailoring emits a `ResumeStore` JSON + `changes[]`; PDF via in-process Playwright, not `build-cv-latex.mjs`.
- **Eval "Stage 3 Deep" cut for MVP** — Stage 1 (JD facts) + Stage 2 (score + 5-tier legitimacy, with escalation) only.
- **`applyUrl` added to `Job`** — required by F3, absent from the frozen §5 contract; freeze it now.
- **Legitimacy 3→5 tiers** — donor's `High Confidence / Caution / Suspicious` maps to §11.8's `verified|clear|suspicious|ghost|scam` (liveness `expired` → `ghost`; `scam` is a new template output).
- **F7 — Manual URL check, and `Persona` widened to include `'pasted'`** (2026-07-12 pasted-job-ingestion spec, supersedes `2026-07-11-manual-url-scan-design.md`): paste a URL → escalation ladder (fetch → sonar search → paste-text) acquires the JD → gate → persist (`sourceId:'manual'`, `persona:'pasted'`) → automatic ghost posting-history web check → full fit + legitimacy scoring → the job lives in a dedicated Pasted feed scope, deletable, tailorable. This **amends** the api-contract.md three-axes paragraph (`Job.persona` now spans `{remote-run, local-run, pasted}`) and locally supersedes the 2026-07-12 eligibility spec's "Persona untouched" lock on that one point — the eligibility spec itself is otherwise unchanged. Scan-only call sites keep the narrower `ScanPersona = z.enum(['remote','local'])` so widening `Persona` doesn't silently propagate into `POST /api/search`, `sourcesRepo`, or `searchRunsRepo`. No literal deferral note for the URL-eval route existed in `api-contract.md` to remove — that deferral lived only in the now-superseded 07-11 spec's own §5.

## Naming
- Tracker entity is **`Application`** (Drizzle table `applications`) — the same records the kit surfaced as `applied[]`. Status folding to the 4-stage pipeline stays in `features/applied/status-map.ts`, never in components.
- New contract types to freeze alongside the frozen §5 set: `ApplicationQuestion`, `ApplicationAnswer(s)`, `TailoredResume`/`TailorChange`, `SearchRun`, `SourceRef`.

## Storybook status
Scaffolded and building at repo root (`npm run storybook` / `npm run build-storybook`). The **13 primitives** are lifted from the donor with your "what you saw" tokens (cool ground, soft radii, red accent) and each has a story with realistic job-search content. `ScoreChip`/`TableControls` deferred (they use tokens we haven't re-mapped). `lucide-react`'s dropped `Linkedin` glyph was substituted with `Link2` in the copied `Icon.tsx`. Compositions and pages (from component-inventory.md) are the next stories to build.

## Open risks
- **MY-board connectors are the only unproven component** (no donor code; scraping fragility; ToS friction). Build **JobStreet first** behind the connector interface; the persona toggle degrades gracefully if a board breaks.
- **F4 form extraction is three-tiered**: (1) structured ATS APIs (Greenhouse questions schema), (2) headless DOM parse (donor `extractFieldsInPage`, remote-ATS only — login-gated boards fail), (3) **paste fallback (always available)** — the universal guarantee.
- **Cost (Gate #5)**: per-run score cap (~30 jobs) + daily cap env var; `costUsd` recorded per score/answer/tailor row from day one.
