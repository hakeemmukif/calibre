# Pasted-Job Ingestion — design

- **Date:** 2026-07-12
- **Status:** Approved (brainstormed with operator; 6-lens adversarial review folded in)
- **Supersedes:** `2026-07-11-manual-url-scan-design.md`. That spec designed the same core (paste URL → gate → persist → score) and its naming, gates, and `scoreJob` extension are **adopted wholesale** here. This spec supersedes it because the feature grew three capabilities its synchronous design cannot carry: a web-search escalation tier, an automatic ghost posting-history check, and a dedicated **Pasted** feed scope with delete. Deltas from the 07-11 spec are marked "**Delta:**" throughout.
- **Feature:** paste a job URL into `UrlEvalBar` → escalation ladder acquires the JD (direct fetch → web search → paste-text fallback) → gate, persist, ghost posting-history check, full fit + legitimacy scoring → inline `EvalResultCard` verdict + the job lives under a third **Pasted** feed scope, deletable, tailorable.

## 1. Goal

Let the operator act on a job URL found anywhere (LinkedIn, Slack, a friend's forward): confirm it is a real posting, extract its facts, score fit + 5-tier legitimacy **including web posting-history ghost evidence**, and keep it in a dedicated Pasted feed scope with the lifelong-tracker and tailoring flows attached.

Everything downstream of "get the job text" exists and is tested: `extractJdFacts`, `scoreJob` (liveness → `scoreMatch` → `resolveLegitimacyTier`), `assembleJob`, tailor, F4 apply-questions. Genuinely new: the acquisition ladder, the `ghost-web` evidence task, the async `url_checks` run, the Pasted scope, delete.

## 2. Locked decisions

1. **Escalation ladder, cheap-first** (operator ambition "3 > 2 > 1"): direct fetch → sonar web search → paste-text fallback. Agentic outcomes are explicit pipeline stages, not a free-running tool loop. Vision/screenshot fallback deferred (unchanged from 07-11).
2. **Ghost posting-history check runs automatically on every pasted job.** Pasted jobs only in v1; scanned jobs keep current Block G.
3. **Application questions are NOT extracted at paste time** — existing F4 flow (`POST /api/apply/questions { jobId?, url?, pastedForm? }`) at apply time.
4. **Result UX: inline `EvalResultCard` under the header bar** (placement is this spec's decision; §11.4 of the standalone design only pairs the components). The job also lands in the Pasted scope.
5. **`Persona` gains `'pasted'`** — an honest reading of "Job.persona = run provenance"; pasting IS the provenance. This **deliberately amends** the api-contract three-axes paragraph and supersedes the eligibility spec's "Persona untouched" lock *on this one point* (that lock was scoped to the eligibility feature). Scan-only code paths get a new narrow `ScanPersona` type (§11).
6. **Adopted from 07-11 verbatim:** naming (`POST /api/jobs/check`, `server/url-check/`, user-facing button "Check"), the `isJobPosting` gate, the `scoreJob` extension (`precomputedJdFacts`, `livenessOverride`), error-code discipline (add only `FETCH_BLOCKED`, `NOT_A_JOB_POSTING`; no-résumé → `CONFLICT`; no `NO_ACTIVE_RESUME` code), the synthetic source row `{ id: "manual", name: "Manual URL", kind: "manual", persona: "both", enabled: false }`, active-résumé check **at admission, before any spend**, `fetchPageText` shape (§7), persist-first Approach A, re-sighting semantics (§10). The UI pill label is **"Pasted"** — copy, not contract.
7. **Ghost evidence never enters the model prompt.** `config/templates/match-score.md` is untouched (its hash is `policyVersion` — editing it would re-version the entire scanned corpus, and the template engine has no optional blocks; `templates.ts` throws on any missing `{{var}}`). Web evidence feeds the deterministic overlay + the UI evidence line only.
8. **No model-invented numbers.** The `ghost-web` task returns `sightings[]` (url, source, date); the overlay counts them deterministically. A hallucinated scalar cannot flip a verdict.
9. **No cost cap on the paste path in v1** (07-11 §12 precedent, single-operator, ≤ ~$0.03/paste — §14). An admission-time cap was fictional under concurrency anyway; revisit before multi-user.
10. **Pasted jobs are never `isNew`** — no scan-run cutoff exists for the scope and `assemble.ts` already yields `false` when the cutoff is null. Zero code, one honest semantic; the "New" chip matches 0 jobs in the Pasted scope (documented, accepted).
11. **Delete: pasted jobs only; blocked when an application exists** (409) — the lifelong-tracker promise wins over deletion.
12. **The eligibility visibility predicate does not hide jobs in the Pasted scope.** The operator pasted them deliberately; hiding a pasted `abroad` job from its own scope would be absurd. `EligibilityTag` still shows the warning; `stats.excluded` is 0 there.

## 3. User flow

1. Paste URL into `UrlEvalBar`, click **Check** → `POST /api/jobs/check { url }` → 202 + `UrlCheck` (or 200 completed with `alreadyKnown: true` — §5).
2. Bar polls `GET /api/jobs/check/:id` (~1.5s) and streams stage text: "Fetching… / Searching the web… / Extracting… / Ghost check… / Scoring…".
3. Completed → fetch `GET /api/jobs/:jobId`, render `EvalResultCard` inline: score badge, role @ company, legitimacy tag + web-evidence line, eligibility tag, fit bar, **Open job** / **Tailor résumé** / dismiss ×. Feed refreshes if the Pasted segment is active.
4. Failed with `needsText: true` (`FETCH_BLOCKED`, `EXTRACTION_FAILED`) → bar reveals a paste-textarea → re-`POST { url, text }`; ladder skips straight to extraction. LinkedIn/Indeed usually land here — expected behaviour, not a bug.
5. Failed with `needsText: false` (`NOT_A_JOB_POSTING`) → inline terminal message.
6. `alreadyKnown` → same card with "Already tracked under Remote · global / Malaysia · local" (names the job's actual scope — it will NOT appear under Pasted; deep-link via Open job).

## 4. Architecture

```
UrlEvalBar ──POST /api/jobs/check──▶ route.ts (thin boundary)
                                        │ admission (sync): parse; getActive résumé →409;
                                        │ text ≤40k →422; dedupe hit →200 alreadyKnown;
                                        │ insert url_checks(queued); fire-and-forget; 202
                                        ▼
                             server/url-check/run.ts (async pipeline)
    stage fetching    fetchPageText(url)         blocked/empty/oversize/non-HTML → tier 2
        + extract gate on fetched text           extract throw / gate fail       → tier 2
    stage searching   'url-check-search' (sonar) found:false → FAIL FETCH_BLOCKED (needsText)
        + extract gate on found content          isJobPosting:false → FAIL NOT_A_JOB_POSTING
    stage persisting  upsertByDedupeKey (source=manual, persona=pasted) + eligibility
    stage ghost-check 'ghost-web' (sonar) → sightings[]   throw → webEvidence:{status:'failed'}
    stage scoring     scoreJob({precomputedJdFacts, livenessOverride, webEvidence})
    complete          url_checks → completed + jobId
                                        ▲
UrlEvalBar ──GET /api/jobs/check/:id──┘ (poll; UI renders stage / needsText / card)
```

Paste mode (`text` present): admission-capped, ladder skipped, extraction onward identical.

## 5. API contract

### Routes (register both in `src/contract/registry.ts`; `route-coverage.test.ts` gates CI)

| Route | Returns | Notes |
|---|---|---|
| `POST /api/jobs/check` | 202 `UrlCheck` (pipeline started) · 200 `UrlCheck` (completed `alreadyKnown` short-circuit) · 409 `CONFLICT` (no active résumé) · 422 `VALIDATION_ERROR` (bad body/URL) · 422 `PAYLOAD_TOO_LARGE` (pasted `text` > 40k chars) | Admission errors are HTTP; pipeline failures land in `UrlCheck.error` |
| `GET /api/jobs/check/:id` | 200 `UrlCheck` · 404 | Poll |
| `DELETE /api/jobs/:id` | 204 · 404 · 409 `CONFLICT` (persona ≠ `'pasted'`, or an application exists) | §10 |

### Entities (`src/types/index.ts`)

```ts
export const UrlCheckRequest = z.object({
  url: z.string().url(),              // always required — applyUrl + dedupe key (dedupeKeyFor throws on bad URLs)
  text: z.string().min(1).optional(), // paste-text fallback; skips fetch/search tiers
});
// Delta from 07-11: no persona field — a checked job is always persona 'pasted'.

export const UrlCheck = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  status: RunStatus,                  // queued | running | completed | failed
  stage: z.string().nullable(),      // fetching|searching|extracting|persisting|ghost-check|scoring (open string — Progress.stage precedent)
  jobId: z.string().uuid().nullable(),
  alreadyKnown: z.boolean(),
  needsText: z.boolean(),             // true ⇔ failure recoverable by pasting JD text (UI keys the textarea on THIS, not on error-code matching)
  error: z.object({ code: ErrorCode, message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
```

`Legitimacy` gains optional `webEvidence` (stored inside the existing `job_scores.legitimacy` jsonb — no migration):

```ts
webEvidence?:
  | { status: 'ok'; summary: string; sightings: { url: string; source: string; postedDate?: string }[];
      companySignals: string[]; confidence: number }
  | { status: 'failed'; reason: string }
```

`status:'failed'` renders as "web check unavailable — verdict from JD signals only". Explicit either way; a flaky search provider cannot kill the paste.

### Error-code additions

`ErrorEnvelope.code` gains exactly **`FETCH_BLOCKED`** and **`NOT_A_JOB_POSTING`** (07-11 §5). Everything else reuses existing members (`CONFLICT`, `EXTRACTION_FAILED`, `PAYLOAD_TOO_LARGE`, `VALIDATION_ERROR`, `UPSTREAM_LLM_ERROR`, `INTERNAL`). `UrlCheck.error.code` uses the same enum. Land the enum change in the same commit as the code that emits it (`features/http.ts` safeParse degrades unknown codes to `INTERNAL`).

### needsText truth table

| Failure | `needsText` | Why |
|---|---|---|
| `FETCH_BLOCKED` (search `found:false`) | true | Paste the JD text |
| `EXTRACTION_FAILED` (gate ran, no company / model didn't answer) | true | Fuller text may fix it |
| `PAYLOAD_TOO_LARGE` (tier-2 content > cap, async) | true | Paste a trimmed JD |
| `NOT_A_JOB_POSTING` | false | Terminal — the page isn't a posting |
| `UPSTREAM_LLM_ERROR` / `INTERNAL` | false | Not fixable by pasting |

## 6. Server pipeline — `src/server/url-check/run.ts`

**Admission (sync, in-route):**
1. `UrlCheckRequest.parse`. 2. `resumesRepo.getActive()` → none → `NoActiveResumeError` → 409 (**before any spend**). 3. `text` > 40k chars → 422. 4. `dedupeKeyFor(url)` → existing job → insert a **completed** `url_checks` row (`alreadyKnown: true`, jobId) for audit, return 200. 5. Insert `url_checks` queued, fire-and-forget, 202.

**Ladder + gate (async).** The extract-gate = `extractJdFacts(llm, text)` then: `isJobPosting === false` → not-a-posting; `isJobPosting === undefined` → extraction-incomplete; `facts.company` absent → extraction-incomplete (no `""` default — fail-loud rule). Per tier:

- **Tier 1 — fetching** (skipped in paste mode): `fetchPageText(url)` (§7). Any `{ok:false}` **escalates to tier 2, never fails**. On `{ok:true}`, run the extract-gate **wrapped in try/catch**: a thrown `llm.complete` (one-shot, no retry — `client.ts` throws on parse/truncation) or any gate failure also escalates — authwall boilerplate legitimately extracts as garbage; that's a signal to search, not to die. (Cost of the discarded extract call ≈ $0.001 — accepted.)
- **Tier 2 — searching**: new LLM task **`url-check-search`** (perplexity/sonar via OpenRouter): given the URL + `<title>` scrap, locate *that specific posting*; returns `{ found: boolean, content, sourceNote }` with citations. `found:false` → **fail `FETCH_BLOCKED`, needsText**. `found:true` → extract-gate on `content`: `isJobPosting:false` → **fail `NOT_A_JOB_POSTING`** (terminal); throw/incomplete → **fail `EXTRACTION_FAILED`, needsText**.
- **Paste mode**: extract-gate on `text` directly; `isJobPosting:false` → `NOT_A_JOB_POSTING`; throw/incomplete → `EXTRACTION_FAILED` (needsText stays true — a fuller paste may fix it).

**persisting:** `jobsRepo.upsertByDedupeKey` with the 07-11 §9 row (title/company from facts; `location: facts.location ?? ""` — documented normalization precedent; `description` = acquired text; `applyUrl`/`url` = pasted URL; `sourceId: "manual"`; `persona: "pasted"`; `aliases: []`; `raw` = facts + acquisition metadata). Eligibility stamped here via `resolveEligibility` with the **precomputed jdFacts** (Layer C available at ingest — better than the scan path; Layers A/B structurally absent for kind `'manual'`). If the upserted row comes back with `sourceId !== 'manual'` (a scan won a concurrent race), complete early as `alreadyKnown` — see §10 re-sighting.

**ghost-check:** new LLM task **`ghost-web`** (sonar): company + title (delimiter-quoted — the strings are attacker-influenced, §7 injection note) → `GhostWebEvidence { sightings[], companySignals[], summary, confidence }`. A thrown call → `webEvidence: { status: 'failed', reason }`, **pipeline continues**.

**scoring:** `scoreJob({ job, resume, llm, precomputedJdFacts, livenessOverride, webEvidence })`. `livenessOverride`: tier-1 fetch succeeded → `'active'`; otherwise → `'uncertain'`, never `'expired'` (a bot-walled URL must not re-probe into a false ghost — 07-11 §8). `webEvidence` is passed through to the overlay and persisted inside `legitimacy`; **not** into `scoreMatch`'s prompt vars.

**Failure & recovery:** the whole pipeline body is wrapped; any uncaught throw marks the row `failed` with a mapped code. **Boot sweep:** `urlChecksRepo.markAllUnfinishedAsFailed()` added to `instrumentation.ts` `register()` beside the search-runs sweep — without it a restart leaves the poller hanging forever (the tailor path has the same latent gap; recorded as a known issue, not fixed here).

## 7. `fetchPageText` — 07-11 §7 plus hardening (SSRF **un-deferred**)

07-11 deferred the SSRF blocklist; this spec un-defers it because arbitrary-URL fetch is now a headline path.

- **Scheme guard:** `http:`/`https:` only — **re-validated on every redirect hop** (redirects handled manually via `Location`, so a `file:`/`gopher:`/`data:` target must be rejected by us, not undici).
- **IP denylist, applied to RESOLVED addresses** (never the host string — decimal/octal/hex literals normalize away): IPv4 loopback/private/link-local (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. metadata 169.254.169.254), 0.0.0.0, CGNAT 100.64/10; IPv6 `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped `::ffff:x.x.x.x` (re-check the mapped v4). `dns.lookup({ all: true })` → every A/AAAA record must pass. Re-resolve + re-check per redirect hop, ≤3 hops.
- **Residual risk, documented:** DNS-rebinding TOCTOU (rebind between our check and undici's connect) is NOT closed by the above. Closing it needs an undici Agent whose connect hook validates `socket.remoteAddress`. **Hard blocker before any hosted deploy; accepted on the local single-operator box.**
- **Byte cap:** stream the body, abort past **2MB** → `{ ok:false, reason:'oversize' }` (escalates). `res.text()` on an unbounded stream is an OOM.
- **Content-type gate:** proceed only on `text/html`/`text/plain`; anything else (PDF/binary) → `{ ok:false, reason:'blocked' }` — the `isJobPosting` gate is the second net.
- **HTML → text:** existing `_html.ts` strip (script/style, tags, whitespace); stripped text capped at **40k chars**. Tier-1 over-cap → `{ ok:false, reason:'oversize' }` (**escalates** — a noisy 300KB page often has a cleaner search-tier answer); tier-2 content over-cap → `PAYLOAD_TOO_LARGE` (async, needsText). Same 40k cap on pasted `text` (sync 422).
- **Blocked detection:** login-wall markers / empty / below ~400 chars → `{ ok:false, reason:'blocked'|'empty' }`.
- **Optional Playwright** behind `CALIBER_LIVENESS_PLAYWRIGHT` (unchanged).
- **Storage:** `url_checks.raw` stores the **stripped text** (never full HTML) — size + PII retention note: pasted text can carry the operator's own data; bounded by the 40k cap.
- **Prompt-injection posture (explicit):** fetched/pasted text is attacker-controlled and flows into `jd-extract` and `scoreMatch`; company/title flow into the sonar queries. Treat all model output over it as untrusted — the deterministic backstops are §8's verified rule and §9's overlay; sonar output only ever feeds the overlay + display.

## 8. Ghost web check — task `ghost-web`

Query: posting history for `{company}` + `{title}` (delimited). Response schema (Zod → `json_schema`):

```ts
GhostWebEvidence = z.object({
  sightings: z.array(z.object({
    url: z.string().url(),        // the citation IS the sighting
    source: z.string(),           // board/site name
    postedDate: z.string().optional(),
  })),
  companySignals: z.array(z.string()),  // e.g. "layoffs announced May 2026", "careers page lists role"
  summary: z.string(),                  // the EvalResultCard evidence line
  confidence: z.number().min(0).max(1),
});
```

Derived **deterministically** by the overlay (never asked of the model): `distinctSightings` = dedupe by (source, postedDate); `count90d` = sightings dated within 90 days; `oldestDays` = age of the oldest dated sighting. Undated sightings count for board-presence but never toward repost churn.

**models.yml:** two new tasks — `url-check-search`, `ghost-web` → `perplexity/sonar`, plus its `prices` entry (fail-loud `priceFor` requires it). `TaskName` union extended. `client.ts` unchanged. **Known unknown:** sonar `json_schema` conformance through OpenRouter — the implementation plan's first task is a 30-minute spike; documented fallback: sonar returns prose + citations, `openai/gpt-oss-120b` structures it (two cheap calls).

## 9. Legitimacy overlay — exact precedence (`resolveLegitimacyTier`)

Inputs gain optional `webEvidence`. Order (first match wins; scanned jobs pass no `webEvidence` — steps 3b/4 inert, **behaviour unchanged**):

1. Model tier `scam` → **scam**. (Web evidence can never upgrade a scam.)
2. `liveness === 'expired'` → **ghost** (unchanged; paste path supplies `livenessOverride`, §6).
3. Model tier `verified`:
   a. *Scanned path* (no webEvidence): `corroborated ? verified : clear` (unchanged).
   b. *Pasted path*: verified requires `corroborated` **AND** `webEvidence.status === 'ok'` **AND** ≥1 sighting whose host is on the ATS/career allowlist (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `workable.com`, `smartrecruiters.com`); else → **clear**. Rationale: for pasted jobs, `corroborated` is asserted by the model from attacker-controlled page text — self-certification is not corroboration (prompt-injection backstop). Multi-board presence (`boardsSeen`) is **not** corroboration — it is simultaneously the repost signal; it stays display-only.
4. Repost rules — only when `webEvidence.status === 'ok'`, applied to tiers `clear|suspicious|ghost` (i.e. **after** the verified branch, so a corroborated-verified evergreen/agency posting is not force-demoted):
   - `count90d ≥ 3 && oldestDays ≥ 60` → **ghost**.
   - `count90d ≥ 3 && oldestDays < 60` → at least **suspicious** (severity max with the model tier).
5. Otherwise the model's `clear|suspicious|ghost` passes through (unchanged).

Severity order: `verified < clear < suspicious < ghost < scam`. `webEvidence.status === 'failed'` → step 4 skips, and 3b's `status === 'ok'` condition cannot be met, so a pasted model-`verified` lands on **clear** (cannot corroborate without web evidence); UI shows the unavailable note.

## 10. Persistence

### `url_checks` (new table — the only migration; persona/kind "enums" are TEXT columns with no CHECK, so widening them needs **no DDL**)

| Column | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `url` / `dedupe_key` | text NOT NULL | |
| `status` | text NOT NULL | queued/running/completed/failed |
| `stage` | text NULL | |
| `job_id` | uuid NULL FK → jobs **ON DELETE SET NULL** | |
| `already_known` / `needs_text` | boolean NOT NULL | explicit values at insert, no column defaults |
| `error` | jsonb NULL | `{code, message}` |
| `cost_usd` | numeric NOT NULL | explicit 0 at insert, summed per LLM call |
| `raw` | jsonb NOT NULL | stripped/pasted text + acquisition metadata (§7 storage note) |
| `created_at` / `finished_at` | timestamptz NOT NULL / NULL | |

### Seeding (two files + a runtime guard)

The `manual` source row goes into **both** `seed.ts` `sourceSeeds` **and** `seed-test.ts`'s independent array (tests break otherwise). `db:migrate` and `db:seed` are unchained npm scripts — deploy step = both. Runtime: `url-check/run.ts` resolves `sourcesRepo.getById("manual")` and throws a specific error naming `npm run db:seed` if absent (fail loud, no raw FK violation).

### Re-sighting / race semantics (documented, accepted for v1)

`upsertByDedupeKey`'s conflict set is `{ lastSeenAt, aliases }` — identity fields are first-writer-wins:
- **Paste after scan** (common): admission dedupe returns the scanned job — `alreadyKnown`, zero spend, card names its real scope. It does not join the Pasted scope.
- **Concurrent paste ↔ scan race** (rare): whoever inserts second keeps the winner's identity; the pipeline detects `sourceId !== 'manual'` after upsert and completes as `alreadyKnown`. Scan-second: the scanned posting re-sights onto the pasted row and stays in the Pasted scope — accepted (that is where the operator put it); a "promote on scan re-sight" policy is deferred.
- **Concurrent duplicate pastes**: both spend (~$0.03 worst case); dedupe short-circuit is best-effort, not a lock. Accepted.

### DELETE `/api/jobs/:id`

Guards in order: 404 unknown → 409 `CONFLICT` when `persona !== 'pasted'` → 409 `CONFLICT` when an `applications` row exists ("tracked application — deletion blocked"; every FK to jobs is RESTRICT, and the tracker promise wins regardless). Then one transaction: delete `application_answers`, `tailored_resumes`, `job_scores` for the job, then the `jobs` row (`url_checks.job_id` nulls via FK). No blanket CASCADE migration — blast radius stays explicit.

## 11. Contract & schema changes (exhaustive)

1. `src/types/index.ts` — `Persona` → `['remote','local','pasted']`; **new `ScanPersona` = `z.enum(['remote','local'])`**; `SourceRef.kind`/`Source.kind` → `['ats','board','manual']`; `UrlCheck` + `UrlCheckRequest` entities; `Legitimacy.webEvidence`; `ErrorEnvelope.code` + `FETCH_BLOCKED`, `NOT_A_JOB_POSTING`.
2. **`ScanPersona` at every scan-only boundary** (widening `Persona` alone does NOT propagate — several signatures hardcode the literal union): `POST /api/search` `RequestBody.persona: ScanPersona` (schema-level 422, the guard has an owner), `StartSearchInput`, `sourcesRepo.listEnabledByPersona`, `searchRunsRepo.getLatestCompleted`.
3. `jobsRepo.JobsQuery.persona` widens to full `Persona` (it currently hardcodes `"remote" | "local"` — `GET /api/jobs?persona=pasted` type-errors without this).
4. `resolveIsNewCutoff(persona)`: `persona === 'pasted'` → return null cutoff **before** calling the ScanPersona-typed repo (isNew:false falls out of `assemble.ts`).
5. `listJobsFeed`: eligibility visibility predicate skipped for `persona === 'pasted'` (§2.12); `stats.excluded = 0` there.
6. `jd-extract`: `JdFactsSchema` + optional `isJobPosting`, optional `company`/`location`/`salaryRaw`; template instruction updated; **fixture** `JD_FACTS` gains `isJobPosting: true` (doubles-mode tests). No policyVersion effect — it hashes `match-score.md` only.
7. `scoreJob` + optional `precomputedJdFacts` / `livenessOverride` / `webEvidence`; `resolveLegitimacyTier` per §9.
8. `dedupe.ts` `CanonicalCandidate.kind` widens to include `'manual'` (typing only).
9. Drizzle: `sources.kind` / `jobs.persona` TS enums widened (no DDL); new `url_checks` table + migration; `urlChecksRepo` (insert, updateStage, complete, fail, getById, `markAllUnfinishedAsFailed`).
10. `instrumentation.ts` `register()` + url_checks boot sweep.
11. `config/models.yml` + `url-check-search`, `ghost-web`, sonar prices; `client.ts` `TaskName` union.
12. Registry: `POST /api/jobs/check`, `GET /api/jobs/check/:id`, `DELETE /api/jobs/:id`; `UrlCheck`/`UrlCheckRequest` in `entitySchemas`; `npm run contract` regen.
13. Seeds: `seed.ts` + `seed-test.ts` manual source row.

Verified by review: no exhaustive `switch` on `source.kind` or `Persona` exists in UI/features that a new value silently breaks; the compile-time gaps are exactly the hardcoded literal unions in (2)–(3).

## 12. UI

**Extend, not new** (both components exist; update `component-inventory.md` prop tables):

- **`UrlEvalBar`** (`{onSubmit, status: idle|evaluating|error, error?}` today): add `success` status, stage-text line during `evaluating`, and the paste-text mode — on a `needsText` failure, reveal textarea + re-submit `{url, text}`. Storybook: every state.
- **`EvalResultCard`** (`{job, onOpen, onSave}` today): add `onTailor`, `onDismiss`, eligibility tag, legitimacy evidence line (`webEvidence.summary` | "web check unavailable — verdict from JD signals only"), `alreadyKnown` note naming the job's actual scope. Storybook: verified/suspicious/ghost, alreadyKnown, web-check-failed variants.
- **`PersonaToggle`**: third segment `{ value: 'pasted', label: 'Pasted' }`. No count badge v1.
- **`feed/page.tsx`**: replace `onSubmit={() => {}}` with the real handler via new `features/url-check/client.ts` (`startCheck`, `getCheck`; poll ~1.5s); on complete fetch the job, render the card, `load()` the feed when the Pasted segment is active. **Hide "Scan now" when `persona === 'pasted'`** (it would fire a guaranteed-422 scan). In the Pasted scope, the JobRow `dismiss` slot becomes **delete-with-confirm** → `DELETE /api/jobs/:id` → refresh; 409 surfaces its message. Scanned-job dismiss stays untouched.
- **Tailor / apply questions:** zero new work — tailor takes any `jobId` (pasted jobs carry full jdFacts, so no degraded context); F4 accepts `url` at apply time.

## 13. Non-goals / deferred

- Vision/screenshot fallback (inherited from 07-11).
- **DNS-rebinding connect-hook pinning — required before any hosted deploy** (§7); accepted residual risk on the local box.
- Cost cap on the paste path; ghost-web for scanned-feed jobs; Pasted-pill count badge; scanned-job dismiss wiring; "promote on scan re-sight" (§10); tailored_resumes boot sweep (same latent gap as url_checks had — known issue).

## 14. Latency & cost budget

Typical: fetch 2–10s + extract 3–5s + ghost-web 8–15s + score 3–8s ≈ **15–30s**; worst (tier-2 search + escalated score) ≈ **50–60s** — hence async + poll (**Delta:** 07-11's "synchronous, no SSE" non-goal is superseded by the added stages). Cost: extract ~$0.001 + score ~$0.002 + sonar ×1–2 ~$0.01–0.02 → **≤ ~$0.03/paste** worst case, noise against the RM3/month gate at operator volume.

## 15. Testing

- **Unit — `fetchPageText`:** strip; blocked/empty/oversize(streaming byte cap)/content-type; scheme + resolved-IP denylist (v4, v6, mapped, metadata, decimal-literal host); per-hop scheme+IP re-validation; 40k cap.
- **Unit — ladder:** tier-1 fetch-fail → tier-2; tier-1 extract-throw → tier-2 (not run-fail); tier-2 `found:false` → `FETCH_BLOCKED` + needsText; tier-2 `isJobPosting:false` → `NOT_A_JOB_POSTING` + !needsText; paste-mode gates; no-résumé 409 **before** any LLM call.
- **Unit — overlay (§9 permutations):** repost≥3+old → ghost; repost≥3+recent → suspicious; corroborated-verified + ATS sighting survives repost rule; pasted verified without ATS sighting → clear; `webEvidence:'failed'` → passthrough; **no-webEvidence (scanned) behaviour byte-identical to today**; undated sightings excluded from churn.
- **Unit — delete:** persona guard; application-exists guard; transaction removes score/tailor/answers rows; url_checks nulls.
- **Unit:** `resolveIsNewCutoff('pasted')` → null; eligibility predicate skipped for pasted scope; boot sweep flips stale rows.
- **Hermetic (`CALIBER_TEST_DOUBLES=1`):** happy path 202 → poll → completed → job under `persona=pasted` with score+legitimacy; paste-text path; alreadyKnown short-circuit; delete → feed re-scope; re-check of existing URL upserts (no 23505).
- **Contract:** route-coverage with three new registered routes; openapi regen; `JD_FACTS` fixture.
- **Spike (first plan task):** sonar `json_schema` conformance via OpenRouter for both new tasks.

## 16. Doc ripple

| Doc | Change |
|---|---|
| `api-contract.md` | +3 routes; `UrlCheck`/`UrlCheckRequest`; error enum +2; **amend three-axes paragraph**: `Job.persona` = run provenance ∈ {remote-run, local-run, **pasted**}; remove the §5 deferral note for the URL-eval route |
| `system-architecture.md` | New **F7 — Manual URL check** flow (pipeline, ladder, ghost-web, SSRF spec pointer, boot sweep) |
| `component-inventory.md` | `UrlEvalBar` / `EvalResultCard` / `PersonaToggle` prop-table updates |
| `docs/architecture/README.md` | Reconciliation entry for F7 + persona widening |
| `2026-07-11-manual-url-scan-design.md` | Status → "Superseded by 2026-07-12-pasted-job-ingestion-design.md" |
| `2026-07-12-remote-local-eligibility-design.md` | No edit; its "Persona untouched" lock is superseded on that single point by this spec (recorded here, §2.5) |
