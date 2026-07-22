# Caliber — Standalone Web App: Design Spec

*Dated design (2026-07-11). Where this document disagrees with the code, the code + `docs/architecture/` win — notably: the Job shape in §5 predates `legitimacy`/`eligibility`/`applyUrl`/`persona`/`firstSeen`/`isNew` (canonical: `src/types/index.ts`), and the primitive count is now 14 (Textarea added). See `docs/architecture/README.md` reconciliations.*

**Status:** Approved design (2026-07-11). Feeds implementation planning (writing-plans).
**Home:** `/Users/hakeem/calibre` (new repo, no runtime dependency on `career-ops`).
**See §11 — Vision expansion & niche (2026-07-11): supersedes where in conflict.** §1–§10 describe porting the 13 kit screens; §11 re-aims the product around the confirmed niche and adds the new surfaces.

---

## 1. Goal & principle

Build a new, self-contained, deployable web app whose look **and** behaviour match the **Caliber "Swiss Grid" design kit** (`~/Downloads/ui_kits 3/careerops-web` + its design system). The design is the stakeholder: what the screens show is what the product does.

The existing `career-ops/careerops-web` repo is a **code donor only** — we extract its real logic and adapt it into this codebase. We do **not** adopt its "Operator" design, its architecture, its job engine, or its file-plane. Its front-end is a separate design effort and is irrelevant here.

**Success = every design screen renders faithfully and its implied functions work, backed by real logic, in one cohesive, readable codebase that deploys on its own.**

### Non-goals (v1)
- No multi-user auth wall / PIN gate / invite system (the design shows none; v1 is single-operator). Auth is a later concern.
- No admin console, spend ledger, email digest sending, public SEO `/verdict` pages, `/demo` gallery — donor features with no design representation.
- No port of the donor's 4,457-line job engine, CLI-subprocess workers (`claude -p`), or shared markdown file-plane. Behaviour is re-implemented clean.

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 (App Router), React 19, TypeScript** | Donor is Next/Node TS → lowest-friction extraction; one framework covers UI + server routes for PDF/LLM. |
| Backend depth | **Full real backend**, re-implemented clean (not ported) | Real from day one, but as modular typed services — no engine/file-plane spaghetti. |
| LLM provider | **OpenRouter** (OpenAI-compatible), model routing config-driven | Cost control; provider-swappable; matches existing council routing. |
| Theme | **The runtime look you saw** — soft radii, cool off-white canvas (`--bg-app` cool), red accent | Faithful to the running kit ("like this"). Tokens stay CSS vars → runtime-swappable later. |
| v1 scope | **All 13 screens as faithful shells first**, then wired to real services | Breadth-first UI; deployable click-through early. |
| Deploy target | **Node host** (Fly.io / Docker / Railway) | Needs Chromium (PDF) + long-running LLM calls; not pure-edge. |

---

## 3. Architecture

```
calibre/
  src/
    app/                     # routes: one folder per screen + /api
      (screens)/…/page.tsx
      api/…/route.ts
    caliber-ui/              # design system: 13 primitives + kit tokens
      components/*.tsx
      styles/tokens.css
      index.ts
    features/                # per-screen logic + typed service interface
      matches/ match-detail/ applied/ resume/ cover/
      interviews/ insights/ sources/ profile/ onboarding/ scan/
    server/                  # backend engines (pure, typed, testable)
      scan/ eval/ resume/ cover/ persistence/
    lib/                     # shared: openrouter client, pdf renderer, utils
    types/                   # canonical data contract (Zod + TS)
  docs/superpowers/specs/
  drizzle/                   # migrations
  tests/                     # vitest unit + playwright e2e
  CLAUDE.md  AGENTS.md  .env.example
```

**Boundary rule (enforced in CLAUDE.md):** UI components never call an engine directly. Screens call typed service functions in `features/*`; those call `server/*`. `server/*` is the only layer touching the DB or OpenRouter. Every unit answers: what it does, how it's used, what it depends on. Files that grow past one responsibility get split.

---

## 4. Design system & theme

**Components — lift-and-shift.** The 13 primitives already exist as clean, typed, byte-faithful TSX in donor `src/caliber-ui/components`: `Avatar, Button, Card, Chip, FitBar, Icon, IconButton, Input, ScoreBadge, Select, SidebarNav, Tabs, Tag`. Copy them in as-is. Keep `Icon` on `lucide-react`. Repo-only extras `ScoreChip` and `TableControls` are useful for dense tables but use Operator token names — include them **only after re-tokening** to the kit vocabulary, else they render broken.

**Tokens — kit vocabulary, "what you saw" values.** Base on the kit's Swiss-Grid `styles.css` (token names: `--text-strong`, `--radius-sm/md/lg`, `--font-body`, `--accent`, `--fit-strong/mid/weak`, `--bg-app`, `--surface-sunken`, …). Set default *values* to the running look:
- accent: red `#e8482b` family
- radius: soft (`--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, pill 999px)
- background: cool (`--bg-app #f6f7fb`, `--surface-sunken #eef0f5`)
- type: Helvetica system stack; no shadows except floating layers; single 140ms transition.

Drop donor's `tokens.css` (Operator), its LEGACY BRIDGE block, and `.cb-*` app-shell CSS. Tokens remain pure `:root` custom properties, so a Tweaks-style runtime reskin stays possible (not shipped in v1).

---

## 5. Data contract (frozen first)

The kit's `window.CO_DATA` shapes become the canonical types in `src/types` (TS interfaces + Zod schemas). Everything — screens, services, API routes — binds to these. Donor data is mapped in via thin adapters, never the reverse.

Core shapes (abridged; full field list carried from the design-side inventory):

```ts
Job {
  id: string; score: number; ghost?: boolean;
  role, company, meta, verdict, why: string;
  tags: { tone: 'verified'|'good'|'warn'|'ghost'; label: string }[];
  breakdown: { label: string; value: number; display?: string; tone?: string }[];
  fit: { k: string; v: string }[];
  gaps: { tone: 'warn'|'ok'; k: string; v: string }[];
}
MatchDetail { archetype; legitimacy; cover; outreach; research }  // enriched per job
ScanStats { scanned, worth, ghosts: number; ago, boards: string }
Applied {
  id, role, company, meta, appliedAgo: string; score: number;
  stage: 0|1|2|3;                     // Applied→Screen→Interview→Decision
  statusLabel: string; statusTone: 'good'|'verified'|'neutral';
  tailored: boolean; note: string;
}
Resume {
  hasResume: boolean; atsScore: number; updated, headline, location, summary: string;
  experience: { title, company, dates: string; bullets: string[] }[];
  skills: string[];
}
CoverLetters { angles; list }
Interviews { upcoming; prep; storyBank }
Patterns { funnel; byArchetype; blockers; remote; insight }        // insights
Sources { ats; queries; companies; recent; schedule; scanned }
Targets / Archetypes / Voice / Negotiation                        // profile
```

**Key adaptation — application status.** Donor statuses (`Evaluated / Applied / Responded / Interview / Offer / Rejected / Discarded / SKIP`) fold onto the design's 4-stage `stage` + `statusTone` via an explicit mapping table in `features/applied/status-map.ts`. `statusTone: 'neutral'` denotes closed.

**Contract gaps the design implies but the kit fakes** (must become real fields): Profile "recent corrections" (hardcoded in kit JSX), per-cover-letter body (kit reuses one draft for all), FitBar `tone:'strong'` (not in the enum — normalise to `good`).

---

## 6. Backend services — full & real, rebuilt clean

We keep donor *behaviour*, discard donor *plumbing*.

- **Persistence — Drizzle + Postgres** (SQLite for local dev). The donor's Drizzle schema for `evaluations`, `user_profiles`, `applications`, `scan_jobs`, `scan_runs`, `verdict_cache` lifts almost directly (minus auth/spend/admin tables). `server/persistence` is the single data-access layer.
- **LLM — OpenRouter client** (`src/lib/llm/`). One OpenAI-compatible client (`baseURL: https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`). Model selection is config-driven (`config/models.yml`: which model per task — scan-triage, evaluate, cover-draft, resume-tailor), so cost/quality is tuned without code changes. No `claude -p` subprocesses.
- **Scan/discovery** (`server/scan`): re-implement donor `scan.mjs` / `scan-ats-full.mjs` behaviour (portal + reverse-ATS discovery) as a typed service. Emits real progress events (SSE or poll) consumed by ScanProgress.
- **Evaluation/scoring** (`server/eval`): re-implement the donor's staged extract→score→deep pipeline (`run-staged.ts`) as a clean service over the OpenRouter client, producing `score` + `legitimacy` + `breakdown`/`reasons`. Cache by policy version.
- **Resume** (`server/resume`): lift the donor's **pure** HTML template-fill (`resume-render.ts`) as-is; PDF via headless Chromium on the Node host; tailoring via the LLM client; PDF *ingestion* via `unpdf`.
- **Cover** (`server/cover`): re-implement `/api/cover` behaviour (angle/problem/approach/tone → draft → approve → PDF).

Each engine exposes a small typed function + one `/api` route. All are unit-tested with mocked LLM/DB.

---

## 7. Screen → donor code mapping

Portability tiers: **T1** lift pure logic · **T2** re-implement behaviour clean · **shell** UI-only for v1 breadth pass.

| Screen | Donor source | Tier | Make-real work (design-only affordances to wire) |
|---|---|---|---|
| AppShell | nav counts from `/api/stats` aggregates | T1 | Sidebar counts bound to real aggregates. |
| Onboarding | `OnboardingWizard.tsx`, `PUT /api/me/profile`, `user_profiles` | T2 | Resume upload dropzone + "Build from scratch" (no handlers in kit) → wire to profile create + resume service. |
| ScanProgress | SSE `JobProgress {stage,current,total,label}`, `sse.ts` | T2 | Replace fixed 5.1s simulation with real scan-service progress events. |
| Matches (Dashboard) | `RadarHome`/`_dashboard-ui`, `/api/stats`, `evaluations`, `radar/match.ts`, `legitimacy`/`liveness` | T2 | Filter chips must actually filter (no-op in kit); ghost flag from legitimacy+liveness; score tiers ≥4/≥3. |
| Match detail | `reports.ts ReportSummary`, `/api/reports`, `FitBar` | T1/T2 | Dimension bars from `dimensions[]`; Fit/Cover/Outreach/Research tabs; Apply/Copy-LinkedIn/Redraft buttons → wire. |
| Applied tracker | `TrackerTable`, `/api/applications`, `store/applications` | T2 | 6→4 status mapping; follow-up cadence; Log-update button. |
| Resume view | `/me ResumeTab`, `/api/me/resume`, `resume.ts`, `ResumeStore` | T1/T2 | ATS score, paper preview, empty state; Tailor/Upload actions. (`/resume` donor page is a stub — use `/me` logic.) |
| Resume builder | `/cv-studio`, `tailor-cv`, `resume-render.ts` (pure), `generate-pdf.mjs`, `/api/me/pdf`, `unpdf` | T1+T2 | Build the split editor + **live preview bound to editor state** (kit preview is hardcoded); AI-polish buttons → tailor service; export → PDF. |
| Cover letters | `/cover`, `/api/cover` + proposal/approve/reject, `CoverInputs` | T2 | Angle toggles → real redraft; per-letter body (kit reuses one draft) → real; Approve/PDF → wire. |
| Interviews | `interview-prep` job, `/api/research/interview-prep`, `buildPrepAgenda` | T2 (partial) | Prep brief + story bank from interview-prep output. Scheduling/calendar is net-new → **deferred** past v1 (flag as design-only for now). |
| Insights | `/analytics`, `/api/gaps`, `/api/patterns`, `/api/followup`, `gaps.ts` | T1/T2 | Funnel/archetype-rate/blockers/remote from `GapsResult`+patterns; fix blocker bar to be data-scaled (kit uses `count*14px`). |
| Sources | `/sources`, `Coverage.tsx`, `coverage.ts`, `/api/coverage`, `/api/discover`, `portals.yml` | T2 | Toggles/config persist; "Scan now" → real scan; discovery approve/reject. |
| Profile & targets | `/me` rail, `/api/profile/edit\|preferences`, `/api/me/profile`, `context-write.ts` | T2 | Targets, archetype weights, voice DNA, negotiation, learning loop; add real "recent corrections" field. |

---

## 8. Governance & scaffolding

- **`CLAUDE.md` / `AGENTS.md`**: project conventions — the layer boundary rule (§3), data-contract-first, no fallbacks/fail-loud, small surgical diffs, no engine/file-plane porting, OpenRouter-only LLM.
- **Skills**: wire the relevant Claude Code skills into the repo (frontend/design, test-driven-development, verification-before-completion).
- **Testing**: Vitest (unit — services with mocked LLM/DB) + Playwright (e2e — click-through of all 13 screens).
- **CI**: typecheck + lint + unit on push.
- **Env** (`.env.example`): `OPENROUTER_API_KEY`, `DATABASE_URL`, `MODELS_CONFIG` path.
- **Deploy**: Dockerfile targeting a Node host with Chromium available.

---

## 9. Phased delivery

Each phase is separately plannable; this doc ties them together. "All faithful shells first" + "full real backend" reconcile as: shells land in A (breadth), the real backend is built comprehensively in B–C, wiring completes in D.

- **Phase A — Foundation.** Scaffold Next.js; copy the 13 components; author kit tokens (what-you-saw values); freeze the `src/types` data contract; app shell + all 13 routes rendered as **faithful static shells on typed fixtures**; `CLAUDE.md`/`AGENTS.md`/skills; Dockerfile. → Deployable click-through of the whole app.
- **Phase B — Persistence + core engines.** Drizzle schema + migrations; OpenRouter client + models config; PDF renderer; scan service; eval service. Matches + ScanProgress + Match detail on real data.
- **Phase C — Feature services.** resume (render/tailor/PDF), cover, applied (+status map), sources, profile, insights, interviews (prep). Screens bound to services.
- **Phase D — Make it real & ship.** Wire every remaining design-only affordance; blocker-bar/FitBar-enum fixes; e2e suite green; deploy.

---

## 10. Risks & open items

- **PDF in production**: headless Chromium needs the right base image; verify on the chosen host early (Phase B).
- **"Full real backend" scope creep**: the guardrail is §1 non-goals + §3 boundaries. If a donor behaviour can't be rebuilt cleanly in a bounded service, it's cut or deferred, not ported dirty.
- **Interviews scheduling** is genuinely net-new (no donor code); v1 delivers prep/story-bank only, scheduling deferred.
- **Single-operator assumption**: no auth in v1; revisit before any real multi-user exposure (donor's shared-file-plane bug is avoided by not porting the file plane).
- **Model choice on OpenRouter**: defaults in `config/models.yml` to be tuned for cost/quality per task; needs a first-pass calibration in Phase B.

---

## 11. Vision expansion & niche (2026-07-11)

This section re-aims the product. §1–§10 stand as the technical foundation (framework, boundaries, design-system lift, backend rebuild, data contract); §11 changes *what we point it at* and *which surfaces lead*.

### 11.1 Niche & wedge (confirmed)
- **Primary user:** Malaysian (then SEA) professionals seeking **remote/global** roles — the builder is the first user. **Malaysia-local** job sources ship at launch too (user decision: "remote + local at launch").
- **Wedge (the headline):** every posting scored for **fit + legitimacy** — ghost-job / scam probability foregrounded. Ghost/fake postings are 18–45% of listings (2025–26 studies); Malaysia logged 1,537 job-scam cases / RM31.8M lost in Q1 2026. **No incumbent tracker (Teal/Huntr/Simplify) leads with legitimacy.** The donor's "Block G" legitimacy detector already implements this — it becomes the marquee.
- **Retention layer:** the lifelong tracker (one-stop career management across years).
- **Template optimization:** an **internal** quality engine (log which scoring templates correlate with real interview outcomes per job family → proprietary data moat), NOT a user-facing headline.
- **Pricing frame:** ~RM19–39/mo, undercutting Teal ($29). Respect Simplify's free-tier bar.
- **Deferred, not dropped:** B40 (later B2G/NGO licensing of the legitimacy engine, funded by Persona A revenue); local white-collar mass-market (later expansion; sits in SEEK's AI kill-zone).

### 11.2 Accepted added scope (vs the donor)
The donor scans global ATS only. Launching local means net-new: **Malaysian-board source connectors** (JobStreet/Hiredly/Maukerja/FastJobs) and **Bahasa Malaysia template variants**. Handled by a **source-connector abstraction** + **`PersonaToggle`** (switches active source-set, language, and role-type presets: `remote-global` ⇄ `malaysia-local`).

### 11.3 Vision → workstreams (fable-able units)
| # | Requirement | Donor coverage | New work |
|---|---|---|---|
| 1 | Scan new jobs as they arrive | scan engine (5 ATS), `scan_jobs`, radar | continuous/scheduled ingestion + "new since last visit" + alerts |
| 2 | Paste a URL to eval a role | `evaluateUrlForUser`, verdict + `jd_cache`/`verdict_cache` | front-door omnibox UI + Caliber styling (logic ~done) |
| 3 | Cheapest model, template-guided LLM | `modes/*.md`, `config/models.yml`, 6-block rubric | OpenRouter routing per task + wire templates to model-config |
| 4 | Templates measured/optimized per job type | `eval_feedback` learning loop, rubric | template registry + per-template metrics (cost/accuracy/calibration) + outcome loop (internal) |
| 5 | Lifelong one-stop career dashboard | tracker, applications, reports, resume, cover, analytics | career-timeline / multi-year history framing |
| 6 | Two directions (remote-global / MY-local) | profile/targets, source config, role-matcher | MY-board connectors + BM templates + `PersonaToggle` presets |
| 7 | Niche strategy | — | resolved (§11.1) |

### 11.4 New design-system components (compose the 13 primitives; none reinvent them)
1. **`UrlEvalBar`** (header omnibox: Input+Button) → **`EvalResultCard`** (ScoreBadge + FitBar + **legitimacy Tag foregrounded**). Front door for #2.
2. **`FeedStream`** — the hero: live verified-jobs feed; each row scored for fit **and** legitimacy, with **`NewBadge`** for since-last-visit items (#1). Distinct from the batch "Matches" screen.
3. **`NotificationBell` + `AlertList`** — "N new roles match your targets" (#1 alerting).
4. **`TemplateStudio`** (internal page) — author/version templates + **`TemplateMetricCard`** (cost/accuracy/calibration) + **`PromptDiff`** (#4).
5. **`PersonaToggle`** — remote-global ⇄ malaysia-local; flips sources/language/role-types (#6). In onboarding + profile + app header.
6. **`CareerTimeline`** — multi-year chronological application history (#5).
7. **Extended `Sources`** + **`SourceConnector`** rows — add Malaysian boards (#6).

### 11.5 Hero re-ordering
v1 leads with **(a)** the verified-jobs `FeedStream` (fit + legitimacy), **(b)** `UrlEvalBar` paste-to-eval, **(c)** the lifelong tracker as retention. Template Studio is internal. The 13 kit screens remain the base; these compositions sit on top.

### 11.6 Validation gates (go/no-go, from the market scan)
Treat as pre-build/early-build checks, not afterthoughts:
1. 10 Malaysian remote-seekers prepay RM29/mo (or RM99 founder-lifetime) off a landing page in 30 days.
2. Ghost-job scorer ≥ ~75% precision on 100 hand-labeled postings (else the wedge is marketing, not product).
3. ≥50% of target users' desired jobs live on scannable ATS sources vs locked platforms (LinkedIn) — else pivot to paste-URL-first.
4. Users self-report outcomes (interview/no-reply) at ≥20% — else the template-optimization moat and tracker stickiness weaken.
5. Inference cost < ~RM3/user/month at 50 scans/day on OpenRouter's cheap tier — else the free tier is unsustainable.

### 11.7 Phase impact
- **Phase A** adds: `FeedStream`, `UrlEvalBar`/`EvalResultCard`, `PersonaToggle`, `NotificationBell` as faithful shells (legitimacy foregrounded in the visual language).
- **Phase B** adds: source-connector abstraction (global ATS + MY boards), continuous ingestion + "new-since" diffing, OpenRouter routing.
- **Phase C** adds: `TemplateStudio` + metrics, Bahasa template variants, `CareerTimeline`.
- Gate #2 (ghost-job precision) and #5 (inference cost) are validated during Phase B.

### 11.8 Hero page — locked treatment: **A · Signal Pill**
Chosen from the 8-treatment exploration (artifact: `claude.ai/code/artifact/b69138d2-d3ff-49d4-b34a-e2cefb03d3f2`). Comfortable, calm cards — legitimacy present but not shouting.

**Header (`AppShell` top row):** `PersonaToggle` (segmented pill: Remote·global ⇄ Malaysia·local) · `UrlEvalBar` (Input + primary "Check" Button, link icon) · `NotificationBell` (count badge).

**Summary strip:** Scanned today · Worth your time · **Flagged ghost/scam** (rendered in `--accent-ink` to draw the eye) · Since last scan. Tabular numerals.

**Filter chips (real, not decorative):** All · New · Verified · Suspicious · Work anywhere · Fit ≥ 4. Each actually filters the feed. *(Chip updated 2026-07-12: eligibility-based "Work anywhere" — `Job.eligibility.tier === 'anywhere'` — replaces the persona-based "Remote" chip, which was tautological inside the remote lens; see 2026-07-12-remote-local-eligibility-design.md §2.7.)*

**Feed row (the composition):** `Card` (hover lift) → [ `ScoreBadge` fit ring, left ] · [ role title + `Tag` legitimacy pill + `NewBadge` · company/location/comp sub · why-you-fit snippet ] · [ `Open` / `Save` / `Skip`·`Dismiss` actions ].

**Legitimacy tones (Tag), semantic — separate from the red accent:** Verified → `verified` teal + badge-check · Clear → `good` green + check · Suspicious → `warn` amber + alert · Ghost → `ghost` grey · Likely scam → `danger` red + alert.

**Data (extends the frozen `Job` type):** `legitimacy { tier: 'verified'|'clear'|'suspicious'|'ghost'|'scam'; tone; summary; confidence?: number }`, `source`, `persona: 'remote'|'local'`, `firstSeen`, `isNew`.

**Adopted alongside A (not v1-blocking):**
- **C · Console** (sortable table) becomes the **saved/tracker view** — the direct "LinkedIn has no tracker" answer.
- **H's plain-language warning banner** may dress the *flagged tail* of the feed as an enhancement once the ghost-scorer is live (turns a legitimacy field into the scam-shield story). Decide after Gate #2.
- **D/G confidence meter** only if the ghost-scorer emits a real confidence *number* (else a tier-only pill is honest; a meter over-promises). Open item for Phase B.

---

## 12. Delivery tooling & sustainability (2026-07-11)

Confirmed workflow decisions (no Figma seat currently).

- **Source of truth: CODE.** Components live as TSX in `caliber-ui`; tokens as CSS custom properties. There is exactly one canon; we never hand-sync two systems.
- **Component + page gallery: Storybook.** The living, browsable, deployable "front-end of all pages," generated from the real code so it can't drift. This is *how we see all pages*. Every primitive and every screen gets a story; design explorations (like the 8 feed treatments) live on as story variants rather than throwaway HTML.
- **Figma: deferred, one-way if ever.** No install now. If a Figma file is needed later (designer handoff, stakeholder review), populate it *from code* via the official Figma MCP's **Code-to-Canvas** (Claude-Code-only write, Feb 2026 partnership) or **html.to.design** — never a manual two-way sync.
- **API contract: schema-first.** **Zod schemas** (co-located with the frozen `src/types` data contract) are the source; generate **OpenAPI** from them (`zod-to-openapi`), and from that a typed client + interactive docs (Scalar/Redoc). Runtime validation, types, and docs all derive from one schema. Versioned in the repo.
- **Phase A gains:** Storybook scaffold + stories for the 13 primitives and the hero page; the Zod→OpenAPI contract surface stood up alongside the data contract.
