# Caliber MVP — System Architecture

Scope: F1–F6 on Next.js 15 (App Router) + TS at `/Users/hakeem/calibre`. Honors spec §3 (UI → `features/*` → `server/*`; only `server/*` touches DB/LLM), §5 frozen contract, §6 clean rebuild, §11 persona/legitimacy wedge, §12 Zod-first contract. Donor = `careerops-web` (+ repo-root `scan.mjs`, `providers/*.mjs`, `role-matcher.mjs`).

## 1. Data model (Drizzle tables)

**sources** — `id text PK` (`greenhouse|lever|ashby|workday|jobstreet|hiredly|maukerja`), `kind 'ats'|'board'`, `persona 'remote'|'local'|'both'`, `enabled bool`, `config jsonb` (slugs, endpoints, query presets), `createdAt`.

**resumes** — `id uuid PK`, `rawText text`, `structured jsonb` (donor `ResumeStore`: `name, contact[{label,value}], summary, experience[{company,title,dates,bullets[],location?}], education[], skills[{label,items}], extras[]`), `originalPath text?` (uploaded file on disk), `sourceKind 'pdf'|'docx'|'paste'`, `atsScore numeric?`, `isActive bool`, `createdAt/updatedAt`. **Reconciliation:** frozen §5 `Resume` (`headline, location, summary, experience, skills[]`) is a *view* derived from `structured` (headline/location from contact lines, skills flattened). Donor shape wins for storage (richer); frozen shape wins at the API boundary.

**search_runs** — `id uuid`, `resumeId FK`, `personas jsonb` (both on upload), `status 'queued'|'running'|'done'|'error'`, `stats jsonb {scanned, matched, scored, ghosts, perSource[{sourceId,found,errors}]}`, `startedAt/finishedAt`, `error text?`. Feeds frozen `ScanStats`.

**jobs** — `id uuid`, `dedupeKey text UNIQUE` (normalized URL), `url text` (canonical posting), `applyUrl text?` (resolved redirect), `sourceId FK`, `externalId text?`, `title, company, location`, `salaryRaw text?`, `description text?`, `postedAt?`, `firstSeenAt, lastSeenAt`, `persona 'remote'|'local'`, `aliases jsonb [{sourceId,url}]`, `raw jsonb`. **Reconciliation:** the donor has *no* `scan_jobs` DB table — scan state lives in `scan-history.tsv` (file plane). Spec §6's "lifts directly" is wrong here; spec §3's no-file-plane rule wins: the TSV columns (`url, first_seen, portal, title, company, status, location`) become this table.

**job_scores** — `id uuid`, `jobId FK`, `resumeId FK`, `score numeric(3,1)` (0–5, donor `evaluations.score` CHECK), `verdict text` (`Apply|Consider|Research first|Skip`), `legitimacy jsonb {tier, tone, summary, confidence?, signals[]}`, `liveness 'active'|'expired'|'uncertain'`, `breakdown jsonb` (dimensions → frozen `Job.breakdown`), `reasons jsonb {for[], against[]}` (donor `evaluations.reasons`), `fit jsonb`, `gaps jsonb`, `jdFacts jsonb`, `model text`, `escalated bool`, `costUsd numeric(8,4)`, `policyVersion text`, `createdAt`. UNIQUE `(jobId, resumeId, policyVersion)` = the verdict cache. **Reconciliation:** donor `legitimacy_tier` is 3-valued (`High Confidence|Proceed with Caution|Suspicious`); §11.8's 5-tier (`verified|clear|suspicious|ghost|scam`) wins — mapping: High Confidence→`clear` (`verified` reserved for corroborated signals), Caution/Suspicious→`suspicious`, liveness=`expired`→`ghost`, `scam` is a new template output. Frozen `Job` (§5) is assembled in `features/feed` from `jobs ⋈ job_scores`.

**applications** — `id uuid`, `jobId FK`, `resumeId FK`, `tailoredResumeId FK?`, `answersId FK?`, `stage int 0..3`, `statusLabel text`, `statusTone 'good'|'verified'|'neutral'`, `note text`, `appliedAt`, `updatedAt`. **Reconciliation:** donor tracker statuses are freeform strings in markdown (`StoredAppRow`); frozen §5 `Applied` 4-stage wins, mapped via `features/applied/status-map.ts` exactly as §5 prescribes. No markdown parsing ported.

**application_answers** — `id uuid`, `jobId FK`, `formSource 'ats-api'|'fetched'|'pasted'`, `fields jsonb` — donor `ApplyAnswers` lifted verbatim: `Array<FormField & {answer: string|null, needs_candidate_confirmation: boolean, rationale?}>`, with `FormField {label, field_type, required, limit?, options?}`; `model, costUsd, createdAt`.

**tailored_resumes** — `id uuid`, `jobId FK`, `baseResumeId FK`, `structured jsonb` (ResumeStore), `changes jsonb [{section,current,proposed,why}]` (donor `cv_changes` shape from `DeepBlocks`), `html text?`, `pdfPath text?`, `status 'draft'|'approved'`, `model, costUsd, createdAt`. Replaces donor `TailorArtifact` file quartet (`cv.html/cv-latex.json/changes.md/preview.pdf`) — LaTeX dropped.

All shapes are Zod schemas in `src/types` (→ OpenAPI per §12); Drizzle columns bind to them.

## 2. Service boundaries (`server/*`)

| Module | Responsibility | In → Out | Donor reused | Rebuilt |
|---|---|---|---|---|
| `server/resume` | F1 ingest, F6 render | bytes/text → `Resume`; ResumeStore → HTML/PDF | **Lift pure:** `pdf-text.ts` (`extractPdfText`, unpdf), `resume-render.ts` (`renderCvHtml` token fill), ResumeStore type from `store/resume.ts` | DOCX (mammoth — donor rejects `.docx`); LLM structuring becomes an OpenRouter `resume-extract` template with json_schema; no proposal/approve file dance — direct row + edit screen |
| `server/search` | F2 discovery | resumeId → jobs upserted + run stats | Endpoint patterns + provider plugin idea from `scan.mjs`/`providers/*.mjs` (Greenhouse `boards-api.greenhouse.io/v1/boards/{slug}/jobs` → `absolute_url`; Lever `api.lever.co/v0/postings/{slug}` → `hostedUrl`); reverse-discovery dataset + 24h company-list cache + slug SSRF guard from `scan-ats-full.mjs`; TSV dedupe semantics | Typed in-process connectors (no `.mjs` subprocess), MY-board connectors net-new, DB-backed dedupe |
| `server/score` | F2 scoring + legitimacy | (job, resume) → `job_scores` | Behaviour of `eval/run-staged.ts`: Stage 1 `JdFacts` extract, Stage 2 `EvalScores` with `shouldEscalate` → stronger model, `global = weighted_mean − red_flag_penalty`; Block G = `legitimacy_tier + legitimacy_signals` inside EvalScores (`compose-report.ts` — no separate verdict module); pre-filter via `role-matcher.mjs` (`roleFuzzyMatch`: ≥2 shared tokens, ≥1 non-baseline, Jaccard ≥0.6) ported to TS | Stage 3 Deep **cut** for MVP; liveness rebuilt in-process (donor shells to Playwright `check-liveness.mjs` → HTTP probe + optional Playwright, same `active|expired|uncertain`); 5-tier legitimacy template extension |
| `server/apply-assistant` | F4 | job → `FormField[]` → answered fields | `snapshotGreenhouseForm` / `extractFieldsInPage` DOM-walk selectors from `apply-form.ts`; `ApplyAnswers`/`FormField` types verbatim | Answering via OpenRouter template; no score-gate job queue — inline call |
| `server/tailor` | F6 | (job, resume) → `tailored_resumes` | Prompt intent of `tailor-cv` mode; `renderCvHtml` (pure lift); changes-list shape | LLM emits tailored **ResumeStore JSON + changes[]** (not raw HTML) so render stays deterministic; PDF via in-process Playwright `lib/pdf.ts`; no needs-review job state — draft/approve rows |
| `server/tracker` | F5 | CRUD applications | Behaviour of `store/applications.ts` + `/api/applications`, `/api/tracker` | DB rows, 4-stage map; markdown tracker parsing not ported |
| `server/persistence` | Drizzle client + repos | — | donor Drizzle patterns inform ours | single data-access layer |
| `lib/llm` | OpenRouter client + `config/models.yml` + template registry | task → completion (json_schema) | prompt-block structure from `eval/prompts.ts` (fixed block order, candidate block last for caching) | OpenAI-compatible client, per-task routing |

## 3. Source-connector abstraction

```ts
interface SourceConnector {
  id: string; kind: 'ats'|'board'; persona: 'remote'|'local'|'both';
  discover(ctx: {targets: RoleTarget[]; since: Date; signal: AbortSignal;
                 onProgress: (e: ProgressEvent) => void}): AsyncIterable<RawPosting>;
  fetchDetail?(p: RawPosting): Promise<{description: string; applyUrl?: string}>;
  extractQuestions?(job: Job): Promise<FormField[] | null>;   // F4 tier 1/2
}
```

`RawPosting {sourceId, externalId?, url, title, company, location?, description?, postedAt?, salaryRaw?}`. Connectors v1: `greenhouse`, `lever`, `ashby` (donor patterns) + `jobstreet`, `hiredly`, `maukerja` (net-new: public search/listing JSON or HTML parse; no login flows). `PersonaToggle` selects `sources WHERE persona IN (active, 'both') AND enabled` and swaps role-preset/language for templates. **F2 dual-search:** the upload-triggered run passes *both* personas — fan-out over the union with `p-limit` (per-connector concurrency 5–10), per-connector timeout, partial-failure tolerated into `stats.perSource`. **Merge/dedupe:** normalize URL → `dedupeKey`; cross-source duplicates matched by `(companySlug, roleTokens-set hash, location)`; when an ATS posting and a board listing collide, the ATS record is canonical (`kind='ats'` wins `jobs.url`), the board URL appended to `aliases`.

## 4. End-to-end flows

**F1 Upload.** Dropzone/paste → `POST /api/resume` (multipart|`{text}`) → `server/resume`: `extractPdfText`|mammoth|passthrough → OpenRouter **`resume-extract`** (cheap; json_schema=ResumeStore) → insert `resumes`, compute `atsScore` heuristic → return frozen `Resume` view → UI edit/confirm screen (keeps donor confirm gate) → kicks F2.

**F2 Search+score.** `POST /api/search {resumeId}` → create run → connectors fan out (both personas) → upsert `jobs` → `roleFuzzyMatch` pre-filter (free) → top-N candidates (cost cap): per job, liveness probe + **`jd-extract`** (cheap → JdFacts) + **`match-score`** (cheap, `shouldEscalate` → stronger; EvalScores + 5-tier legitimacy) → `job_scores` → progress streamed via `GET /api/search/:id` (SSE) → `GET /api/jobs?persona&filter` returns frozen `Job[]` for `FeedStream`.

**F3 Apply-out.** Feed row "Open" → plain `<a target="_blank" rel="noopener" href={job.applyUrl ?? job.url}>`. No server round-trip (optional `POST /api/jobs/:id/events {opened}` for funnel data).

**F4 Question assistant.** Job detail → `POST /api/apply/questions` → `server/apply-assistant.extractQuestions` (tiers §5) → `FormField[]` → user reviews → `POST /api/apply/answers {fields}` → **`question-answer`** template (mid-tier; grounded on ResumeStore + JdFacts; unanswerable fields get `answer: null, needs_candidate_confirmation: true`) → `application_answers` row → editable answer cards.

**F5 Mark applied.** "Applied" button → `POST /api/applications {jobId, tailoredResumeId?, answersId?}` → `server/tracker` inserts `stage:0, statusTone:'good'` → frozen `Application` returned; tracker screen `PATCH /api/applications/:id` for stage moves via status-map.

**F6 Tailor.** "Tailor for this job" → `POST /api/tailor {jobId}` → **`tailor`** template (strongest tier: ResumeStore + JdFacts + score gaps → tailored ResumeStore + `changes[]`) → `tailored_resumes` draft → UI diff view → `GET /api/tailor/:id/pdf` → `renderCvHtml` + Playwright PDF; "Use for application" links it into F5.

Model tiers (`config/models.yml`): `resume-extract`, `jd-extract`, `match-score` = cheapest viable with `match-score` escalation; `question-answer` = mid; `tailor` = strong. `policyVersion` = template-file hash → score cache invalidation.

## 5. Hard problems

**F4 — getting external form questions.** V1 is three-tiered: **(1) Structured ATS APIs** — Greenhouse `…/jobs/{id}?questions=true` returns the real form schema; highest fidelity, zero scraping. **(2) Headless fetch + DOM parse** — port donor `extractFieldsInPage` (walks `#application_form`/`.application--form`, strips `*`/`(required)`, captures `field_type/limit/options`) and extend for Lever/Ashby; server-side Playwright (already in the image for PDF). Fails on bot walls and login-gated boards — JobStreet/Hiredly forms sit behind auth, so tier 2 is effectively remote-ATS-only. **(3) Paste fallback (always visible)** — user pastes form text/JD; a cheap **`question-extract`** template parses it to `FormField[]`. Tier 3 is the universal guarantee. Browser extension = post-MVP.

**Résumé parsing fidelity.** unpdf text-layer only — scanned PDFs throw; surface the error with a paste prompt, no OCR in v1. Mitigate LLM structuring drift with json_schema output + a mandatory edit/confirm screen before the résumé drives scoring.

**Dual-source dedupe.** URL normalization is primary; the real risk is the same role on JobStreet *and* the company's Greenhouse — the `(companySlug, roleTokens hash, location)` secondary key catches most; false merges are low-cost (aliases retained).

**Apply-URL capture.** ATS APIs give canonical URLs (`absolute_url`, `hostedUrl`). Board listings often redirect to an external apply target — on `fetchDetail`, follow redirects (≤3 hops, same-origin-or-ATS whitelist per donor SSRF guard) and store the resolved `applyUrl` separately from the listing `url`.

## 6. Upfront decisions & risks

1. **Résumé file storage:** original bytes to a host disk volume (`data/uploads/`), path in DB; text+structured in DB. No S3 for single-user MVP.
2. **Search execution:** inline async in the Node process (no queue infra); in-memory run registry keyed by `search_runs.id`; hard runtime cap. A restart kills a run (status `running` → mark stale on boot).
3. **Progress:** SSE (donor `sse.ts` precedent) with polling fallback on `GET /api/search/:id`.
4. **Auth:** none in-app (spec non-goal); if deployed publicly, basic-auth at the proxy. Revisit before multi-user.
5. **PDF:** Playwright-Chromium baked into the Docker image, invoked in-process — validate the base image in Phase B.
6. **Template/model config:** `config/models.yml` (task→model+escalation) + versioned template `.md` files with Zod json_schemas; template hash = `policyVersion` (also seeds the §11 internal metrics moat later).
7. **DB:** Postgres prod / SQLite dev — restrict to Drizzle-portable `json` + `text` column modes; no pg-only types.
8. **Cost cap (Gate #5):** per-run score cap (~30 jobs) + daily cap env var; `costUsd` recorded per score/answer/tailor row from day one.

Open risk: **MY-board connectors are the only truly unproven component** (no donor code, scraping fragility, possible ToS friction) — build one (JobStreet) first behind the connector interface and let the persona toggle degrade gracefully if a board breaks.
