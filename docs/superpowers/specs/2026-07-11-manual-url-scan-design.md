# Manual URL Scan — design

- **Date:** 2026-07-11
- **Status:** Superseded by `2026-07-12-pasted-job-ingestion-design.md` (which adopts this spec's naming, gates, and `scoreJob` extension, and extends it with a search-escalation tier, an automatic ghost posting-history check, an async `url_checks` run, a dedicated Pasted feed scope, and delete)
- **Feature:** paste a job URL → verify it is a real posting → extract fields, score fit + legitimacy → persist into the feed. A manual, single-URL equivalent of the automated market scan, reusing the existing scoring pipeline.

## 1. Goal

Let a user act on a job URL found anywhere (LinkedIn, a Slack message, a friend's forward) the same way the automated scan acts on discovered postings: confirm it is a genuine job posting, extract its facts, and run the full fit + 5-tier legitimacy scoring — then keep it in the feed like any other job.

Everything downstream of "get the job text" already exists and is tested: `extractJdFacts` (Stage 1), `scoreJob` (liveness → `scoreMatch` → `resolveLegitimacyTier`), and `assembleJob`. The only genuinely new capability is turning an arbitrary URL into readable text, plus a small "is this even a job posting?" gate.

## 2. Locked decisions (from brainstorming)

1. **Auto-fetch first, paste-text fallback.** Try to fetch the URL server-side. When that is blocked/empty (the LinkedIn/Indeed reality), tell the UI to reveal a paste-text box; the user pastes the JD text and re-submits. Screenshot/vision fallback is **deferred** (needs a vision model + a new LLM task).
2. **Persist into the feed.** A successful check writes a real job row (`source = manual`) and a `job_scores` row; the job appears in the feed alongside auto-discovered jobs.
3. **Requires an active résumé** (global, not persona-scoped — see §6). No active résumé → `409 CONFLICT`, not a silent skip.
4. **Add a `manual` source kind** as a deliberate contract change (`src/types` → OpenAPI → docs).
5. **Approach A — persist-first, reuse the scoring pipeline.** Rejected: a separate ephemeral pipeline (duplicates orchestration) and refactoring `scoreJob` to score-without-persisting (no benefit given we persist anyway).

## 3. User flow

1. User pastes a URL into the existing `UrlEvalBar` and clicks **Check**. The check runs under the currently-selected persona (`AppShellHeader` already owns persona state).
2. `POST /api/jobs/check { persona, url }`.
3. **Auto-fetch success →** result returns a scored `Job` (200). The UI renders `EvalResultCard`; the job is now in the feed.
4. **Fetch blocked →** `422 FETCH_BLOCKED`. `UrlEvalBar` reveals a paste-text box. User pastes the JD text and re-submits `POST /api/jobs/check { persona, url, text }`; same pipeline from extraction onward, `applyUrl` stays the original URL.
5. **Not a job posting →** `422 NOT_A_JOB_POSTING`, shown inline.

> **Naming note.** The route is `/api/jobs/check`, not `/api/scan`, and its server/feature modules live under `url-check/`. "Scan" already denotes the automated market scan in the codebase (`useScanRun`, `ScanStatus`, `scanStages`); reusing it here would be a genuine source of confusion. The user-facing button stays "Check".

## 4. Architecture (Approach A)

```
UrlEvalBar (UI) ──POST /api/jobs/check──▶ route.ts (thin boundary)
                                             │
                                             ▼
                                  server/url-check/run.ts  (orchestrator)
   1. resumesRepo.getActive()                │  → 409 CONFLICT if none
   2. get text:                              │
        url  → fetchPageText(url)            │  → 422 FETCH_BLOCKED on block/empty
        text → use as-is (paste fallback)    │  → 422 PAYLOAD_TOO_LARGE if oversized
   3. extractJdFacts(llm, text)              │  → 422 NOT_A_JOB_POSTING if !isJobPosting
        gate on facts.isJobPosting           │  → 422 EXTRACTION_FAILED if no company
   4. jobsRepo.upsertByDedupeKey(...)        │  synthetic row, source=manual
   5. scoreJob({ job, resume, llm,           │  liveness override + precomputed facts
        precomputedJdFacts, livenessOverride })│ persists job_scores
   6. assembleJob({ job, score, source },    │  → Job (200)
        { isNewCutoff })                      │
```

All DB/LLM work stays in `server/*`; the route only validates input and maps errors to `ErrorEnvelope`.

## 5. API contract

### Endpoint

`POST /api/jobs/check` — register in `src/contract/registry.ts` (else `route-coverage.test.ts` fails CI).

### Request — new `UrlCheckRequest` entity (`src/types/index.ts`)

```ts
export const UrlCheckRequest = z.object({
  persona: Persona,
  url: z.string().url(),          // always required — becomes applyUrl + dedupe key
  text: z.string().min(1).optional(), // present only on the paste-text fallback; skips fetch
});
```

`url` is required in both modes so `applyUrl` and `dedupeKeyFor(url)` are always well-formed (`dedupeKeyFor` throws on an invalid URL — the `.url()` validation is what makes it safe).

### Responses

| Status | Body | When |
|--------|------|------|
| 200 | `Job` (existing) | Scored and persisted |
| 409 | `ErrorEnvelope` `CONFLICT` | No active résumé |
| 422 | `ErrorEnvelope` `FETCH_BLOCKED` | Auto-fetch blocked/empty → UI reveals paste box |
| 422 | `ErrorEnvelope` `NOT_A_JOB_POSTING` | Extraction says the page is not a job posting |
| 422 | `ErrorEnvelope` `EXTRACTION_FAILED` | Job posting, but no hiring company could be identified |
| 422 | `ErrorEnvelope` `PAYLOAD_TOO_LARGE` | Fetched or pasted text exceeds the size cap |
| 422 | `ErrorEnvelope` `VALIDATION_ERROR` | Bad request body |
| 502 | `ErrorEnvelope` `UPSTREAM_LLM_ERROR` | LLM call failed |

### Error-code additions

`ErrorEnvelope.code` is a fixed Zod enum (`src/types/index.ts:179`). Add two members:

- `FETCH_BLOCKED`
- `NOT_A_JOB_POSTING`

Reuse existing codes for the rest (`CONFLICT`, `EXTRACTION_FAILED`, `PAYLOAD_TOO_LARGE`, `VALIDATION_ERROR`, `UPSTREAM_LLM_ERROR`). **Do not** mint a `NO_ACTIVE_RESUME` code — `NoActiveResumeError` already maps to `CONFLICT` elsewhere (`search/route.ts`); keep that precedent.

> `features/http.ts` `safeParse`s the envelope, so if a new code is emitted before the enum is updated it silently degrades to a generic `INTERNAL` error rather than surfacing. Land the enum change in the same commit as the server code that emits the codes.

## 6. Server pipeline

### New: `src/server/url-check/run.ts` — `checkUrl(req: UrlCheckRequest): Promise<Job>`

1. **Résumé.** `resumesRepo.getActive()` — **global, no persona argument** (résumés are not persona-scoped). None → throw `NoActiveResumeError` → `409 CONFLICT`.
2. **Text.**
   - Paste mode (`text` present): use `text` verbatim (still size-capped, see §7).
   - Fetch mode: `fetchPageText(url)`; `{ ok: false }` → throw `FetchBlockedError` → `422 FETCH_BLOCKED`.
3. **Extract + gate.** `extractJdFacts(llm, text)`.
   - `facts.isJobPosting === false` → throw `NotAJobPostingError` → `422 NOT_A_JOB_POSTING`.
   - `facts.isJobPosting === undefined` → throw `ExtractionIncompleteError` → `422 EXTRACTION_FAILED` (the model failed to answer the gate — fail loud at the boundary, no default; see §8).
   - `facts.company` absent → throw `ExtractionIncompleteError` → `422 EXTRACTION_FAILED` (`jobs.company` is NOT NULL and the feed card shows it; **no `""` default** — fintech fail-loud rule).
4. **Persist the synthetic job.** `jobsRepo.upsertByDedupeKey(...)` — see §9. Returns the `JobRow`.
5. **Score.** `scoreJob({ job, resume, llm, precomputedJdFacts: facts, livenessOverride })` — see §8. Persists the `job_scores` row.
6. **Assemble.** Build `{ job, score, source }` from the upserted row, `scoreJob`'s return, and `sourcesRepo.getById("manual")`; call `assembleJob(joined, { isNewCutoff: await resolveIsNewCutoff(persona) })`. Return the `Job`.

### New: `src/server/url-check/fetch-page.ts` — see §7.

### Route: `src/app/api/jobs/check/route.ts`

Thin boundary: `UrlCheckRequest.parse(body)`, call `checkUrl`, map the typed errors above to `ErrorEnvelope`. Mirror the shape of `src/app/api/search/route.ts`.

### Feature client: `src/features/url-check/client.ts`

`checkUrl(persona, url, text?) → Job`, using `features/http.ts`. Replaces `onEval={() => {}}` in `feed/page.tsx`.

## 7. `fetchPageText` specification

Signature:

```ts
type FetchPageResult =
  | { ok: true; text: string }
  | { ok: false; reason: "blocked" | "empty" | "error" };

async function fetchPageText(url: string): Promise<FetchPageResult>;
```

Rules:

- **Scheme guard.** Reject anything but `http:`/`https:` up front. (Private-IP / SSRF blocklist is **deferred** — noted in §12; this is the first user-supplied URL the server fetches.)
- **Plain HTTP first.** `fetch` with a browser-like `User-Agent`, follow redirects, ~10s timeout.
- **HTML → text.** No readability/cheerio/jsdom in prod deps (jsdom is dev-only). For MVP: strip `<script>`/`<style>` blocks, then strip remaining tags, collapse whitespace. Raw job pages run 200KB–2MB and are full of nav/footer/script noise — feeding raw HTML to `jd-extract` poisons extraction and blows token budget (`jd-extract` `maxTokens` caps *output*, not input).
- **Size cap.** Cap the stripped text (e.g. ~40k chars). Over the cap → the route returns `422 PAYLOAD_TOO_LARGE`. Same cap applies to pasted `text`.
- **Blocked detection.** Login-wall markers, empty body, or a stripped result below a minimum length → `{ ok: false, reason: "blocked" | "empty" }`.
- **Optional Playwright.** Behind the existing `CALIBER_LIVENESS_PLAYWRIGHT` gate, for JS-rendered pages: `page.textContent("body")` (same pattern as `liveness.ts:60`). Inert unless the operator has confirmed browsers are installed.

LinkedIn/Indeed will *usually* land in the blocked branch → paste-text fallback. That is expected behaviour, not a bug.

## 8. `scoreJob` extension (backward-compatible)

Two problems force a small, additive change to `scoreJob` (`src/server/score/index.ts`). Both new params are optional, so every existing caller (`scoreTopCandidates`) is unaffected.

```ts
export async function scoreJob(args: {
  job: JobRow;
  resume: ResumeRow;
  llm: LlmClient;
  precomputedJdFacts?: JdFacts;        // NEW
  livenessOverride?: LivenessResult;   // NEW
}): Promise<JobScoreRow>
```

- **`precomputedJdFacts` — avoid double extraction.** The scan already calls `extractJdFacts` for the `isJobPosting` gate. Without this param, `scoreJob` would call it *again* (`index.ts:35`) — double cost, double latency, and the two calls can disagree (the gate passing on facts that differ from the ones persisted). When provided, `scoreJob` uses these facts and skips its own extraction. When absent, behaviour is unchanged.
- **`livenessOverride` — avoid a second URL fetch and a false "ghost".** `scoreJob` normally runs `probeLivenessDeep(url)` (`index.ts:33`). For a manual check we already touched the URL:
  - Fetch-mode success → the page loaded → pass `"active"`.
  - Paste-mode (fetch was blocked) → pass `"uncertain"`, **not** `"expired"`. This matters: re-probing a bot-walled URL can 404 → `resolveLegitimacyTier` would force `ghost` (`legitimacy.ts:40`) and tag a posting the user is literally reading as "Likely stale". `"uncertain"` avoids that.
  - When absent, `scoreJob` probes as today.

### `isJobPosting` on `JdFactsSchema`

Add `isJobPosting: z.boolean().optional()` to `JdFactsSchema` (`jdFacts.ts:10`) and instruct it in `config/templates/jd-extract.md`.

- **Optional in the schema** so the shared automated path (`scoreTopCandidates`) never fails a `JdFactsSchema.parse` because a cheap model omitted the field — a required field would turn omissions into silently-unscored jobs (`run.ts` swallows scoring errors).
- **Required at the scan boundary**: `checkUrl` throws if `isJobPosting === undefined` (boundary validation, not a fallback default).
- **No cache invalidation.** `policyVersion` on `job_scores` hashes `match-score.md`, *not* `jd-extract.md` (`index.ts:78`, `templates.ts:79`). Editing `jd-extract.md` triggers **zero** re-score of existing rows.
- **Fixture update required.** The scripted `JD_FACTS` fixture (`scripted-fixtures.ts`) must add `isJobPosting: true`, or doubles-mode tests break.

## 9. Persistence

### The synthetic `jobs` row

Built from `JdFacts` + request, written via **`jobsRepo.upsertByDedupeKey`** (not a raw insert — `jobs.dedupeKey` is unique; pasting a URL the automated scan already found would otherwise be a `23505` → 500).

| Column | Value | Note |
|--------|-------|------|
| `dedupeKey` | `dedupeKeyFor(url)` | Unique key; safe because `url` is `.url()`-validated |
| `title` | `facts.title` | Required in `JdFactsSchema` |
| `company` | `facts.company` | Guaranteed present — else `422 EXTRACTION_FAILED` at step 3 |
| `location` | `facts.location ?? ""` | Documented `?? ""` normalization precedent (`run.ts:311`) |
| `salaryRaw` | `facts.salaryRange ?? null` | |
| `description` | the fetched/pasted text | What `scoreJob` scores |
| `applyUrl` / `url` | `url` | |
| `sourceId` | `"manual"` | NOT NULL FK → the seeded manual source (§10) |
| `persona` | `req.persona` | |
| `aliases` | `[]` | NOT NULL |
| `raw` | extracted facts / source text | NOT NULL |
| `firstSeenAt` | now | |

### Re-sighting semantics (must be documented behaviour)

`upsertByDedupeKey`'s `ON CONFLICT` set is only `{ lastSeenAt, aliases }`. So checking a URL the automated scan (or a prior check) already stored:

- keeps the **original** `sourceId`, `description`, `persona` — a re-checked known job is **not** re-labelled `manual`;
- means `scoreJob` scores the **stored** description, even though the `isJobPosting` gate ran on freshly-fetched text.

This is acceptable (the job already exists and was scored); the spec records it so it is not discovered as a surprise. The scan still re-scores (upserts `job_scores`), so the user gets a fresh verdict.

## 10. Contract & schema changes (exhaustive)

Adding the `manual` source touches five places; all are required for a manual job to persist, assemble, and render:

1. **`src/types/index.ts`** — `SourceRef.kind: z.enum(["ats", "board", "manual"])`. Until widened, `assembleJob`'s `Job.parse` throws at runtime for any manual job (`source.kind` flows straight in, `assemble.ts:55`).
2. **DB schema (`schema.ts:68`)** — add `"manual"` to the `sources.kind` TS enum. Drizzle text enums emit no CHECK constraint, so **no DB migration** is needed.
3. **Seed (`seed.ts`)** — add a `manual` source row: `{ id: "manual", name: "Manual URL", kind: "manual", persona: "both", enabled: false }`. **`enabled: false` is mandatory** — an enabled source is fed into `listEnabledByPersona` → search fan-out → `connectorForSource("manual")` throws (`connectors/index.ts:23`), and in doubles mode silently runs the fixture connector.
4. **`dedupe.ts`** — widen `CanonicalCandidate.kind` to include `"manual"` (typing only; `run.ts:281` passes `source.kind` in). Manual jobs never enter `groupByCollision`, and `resolveCanonicalCollision`'s "non-ats loses" behaviour is already correct.
5. **`ErrorEnvelope.code`** — add `FETCH_BLOCKED`, `NOT_A_JOB_POSTING` (§5).

Then: add `UrlCheckRequest` to `entitySchemas`, `registry.registerPath` for `POST /api/jobs/check`, run `npm run contract` to regenerate `contract/openapi.json`.

Verified safe: no exhaustive `switch` on `source.kind` exists in UI/features (`TIER_LABEL` keys on `LegitimacyTier`, not kind), so a new value does not silently break a mapping.

## 11. UI

The UI is **new component work**, not pure reuse. `UrlEvalBar` today supports only `idle | evaluating | error` (`UrlEvalBar.tsx:7`); there is no paste-text affordance anywhere in `caliber-ui`.

- **`UrlEvalBar`** — add a paste-text state: on `FETCH_BLOCKED`, reveal a textarea + re-submit. New composition state + a Storybook story.
- **`feed/page.tsx`** — replace `onEval={() => {}}` with a real handler: call `checkUrl`, track status, map `ApiError` codes (`FETCH_BLOCKED` → reveal paste box; `NOT_A_JOB_POSTING`/`EXTRACTION_FAILED` → inline message).
- **Post-success** — render `EvalResultCard` from the returned `Job`, then **refresh the feed** (`load()`), so the new job (sorted first by `firstSeenAt desc`) appears. The handler must pass the same `isNewCutoff` (`resolveIsNewCutoff(persona)`) the feed uses, so the `Job.isNew` in the response matches the feed reload (otherwise the response says `isNew: false` while the reload shows `isNew: true`).

## 12. Non-goals / deferred

- **Screenshot / vision fallback** — needs image upload UI, a vision-capable OpenRouter model, and a new LLM task in `config/models.yml`. Follow-up.
- **SSRF private-IP blocklist** — v1 pins `http(s):` schemes only; blocking redirects to `localhost`/link-local/metadata IPs is deferred. Documented risk.
- **Streaming progress** — the check is a synchronous request (~10–30s); the existing `Checking…` state covers it. No SSE.
- **Manual-scan cost-cap enforcement** — `dailyCapUsd` lives in `scoreTopCandidates`, not `scoreJob`, so manual checks bypass it. Accepted for a single-operator MVP. An optional short-circuit (skip re-scoring when a fresh `job_scores` row already exists) is a possible later optimisation.

## 13. Latency budget

Worst case: fetch (~10s) + `jd-extract` (once, ~2–5s) + `scoreMatch` (~2–5s, + possible escalation) — liveness is now an override, so no extra probe and no double-Chromium. Set per-stage timeouts (fetch 10s, each LLM call bounded by its client timeout). No framework route timeout exists in this repo (`next.config.mjs` is bare, no `maxDuration`), so the request will not be force-killed; the constraint is UX, not a hard cap.

## 14. Testing

- **Unit — `fetchPageText`**: HTML→text strip; success; login-wall → `blocked`; empty body → `empty`; non-http scheme rejected; oversize → cap.
- **Unit — `checkUrl` gating**: `isJobPosting:false` → `NotAJobPostingError`; `isJobPosting:undefined` → throw; missing company → `ExtractionIncompleteError`; no active résumé → `NoActiveResumeError`.
- **Unit — `scoreJob` extension**: `precomputedJdFacts` skips extraction; `livenessOverride` skips the probe and prevents forced-ghost on paste mode.
- **Hermetic (`CALIBER_TEST_DOUBLES=1`, mock LLM)**: happy path → `POST /api/jobs/check` returns a valid `Job` and writes `jobs` + `job_scores`; paste-text path; no-résumé → 409; re-check of an existing URL upserts rather than 500s.
- **Contract**: `route-coverage.test.ts` passes with the new registered route; `npm run contract` regenerates `openapi.json`; update the `JD_FACTS` scripted fixture with `isJobPosting`.

## 15. Reuse map (what already exists)

| Step | Reused code | Change |
|------|-------------|--------|
| Extract facts | `extractJdFacts` / `JdFactsSchema` (`jdFacts.ts`) | + optional `isJobPosting` |
| Fit + legitimacy score | `scoreJob` (`score/index.ts`) | + 2 optional params (§8) |
| Legitimacy overlay | `resolveLegitimacyTier` (`legitimacy.ts`) | none |
| Emit `Job` | `assembleJob` (`features/feed/assemble.ts`) | none |
| Persist job | `jobsRepo.upsertByDedupeKey` (`repos/jobs.ts`) | none |
| Résumé | `resumesRepo.getActive` (`repos/resumes.ts`) | none |
| LLM | `llm.complete` + `config/models.yml` (`jd-extract`, `match-score`) | no new task |
| Fetch text | — | **new** `fetchPageText` |
| Orchestrate | — | **new** `url-check/run.ts` |
| UI | `UrlEvalBar`, `EvalResultCard` | new paste-text state + real handler |
