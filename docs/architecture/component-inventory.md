# Caliber MVP — Component Inventory & Storybook Blueprint

Grounded in spec §4/§5/§11.4/§11.8/§12. Everything composes the 14 primitives; nothing reinvents them.

## 0. Contract notes (read first)

All compositions take **whole contract objects** (`Job`, `Resume`, `Application`), never exploded scalars — props stay aligned with `src/types` by construction. Notes:

- The tracker record is the entity **`Application`** (Drizzle `applications`); it is what the kit surfaced as `applied[]`.
- **`applyUrl: string` is required by F3 but absent from §5** — added to `Job` at contract-freeze. Same for the F4/F6 types (`ApplicationQuestion`, `ApplicationAnswer`, `TailorDiffEntry`), which are net-new contract additions.

```ts
type Persona = 'remote' | 'local' | 'pasted';
type LegitTier = 'verified'|'clear'|'suspicious'|'ghost'|'scam';
interface Legitimacy { tier: LegitTier; tone: 'verified'|'good'|'warn'|'ghost'|'danger'; summary: string; confidence?: number }
// Job (§5) extended per §11.8 + F3:
interface Job { /* §5 fields */; legitimacy: Legitimacy; applyUrl: string; source: string; persona: Persona; firstSeen: string; isNew: boolean }
```

Tier→tone mapping lives in exactly one place (`legitimacyTone(tier)`); components render `Tag` from it — never hand-pick tones. No fallback rendering: a `Job` missing `legitimacy` throws in the Zod boundary, not defaults to grey.

Eligibility mirrors the same pattern (2026-07-12 spec §8): `Job.eligibility { tier: 'anywhere'|'eligible'|'local'|'abroad'|'unknown'; tone; summary }`, rendered by **`EligibilityTag`** (`src/caliber-ui/lib/eligibility.tsx` — `eligibilityTone`/`eligibilityLabel`/`EligibilityTag`) beside the legitimacy pill; callers suppress it when `tier === 'local'`. A missing `eligibility` throws in `assembleJob`.

`Tone` gained `'neutral'` and `Job.tags[]` gained an optional `title` (remote-fit spec §11, D2): `assembleJob` appends stated-only schedule/structure pills after the legitimacy tag — `emea`→"EU hours"/`americas`→"US hours" (`apac` suppressed, mirrors the eligibility `local` suppression), `title` carries the verbatim `jdFacts.tzRequirement` tooltip; `local-entity`→"Local entity"/`eor`→"EOR"/`contractor`→"Contractor". `JobRow` renders exactly the `neutral`-toned tags (legitimacy tones are always semantic, so this never duplicates the legitimacy pill); `JobDetail`'s existing `tags.map` picks them up automatically. A stated `jdFacts.workCalendar` also appends a `{ tone: 'warn', k: 'Work calendar', v }` entry to `Job.gaps`, rendered by JobDetail's Gaps panel for free.

## 1. Component inventory

`NewBadge` is the one new near-primitive (a styled `Chip`-sized dot+label; props `{ label?: string }`).

| Component | Purpose | Key props (TS) | Composes | States/variants to story |
|---|---|---|---|---|
| **PersonaToggle** | Switch source-set/language presets | `{ value: Persona; onChange(v): void; disabled?: boolean }` | Chip×3 (segmented pill) | remote / local / pasted / disabled |
| **UrlEvalBar** | Paste-URL front door (F2/F7) | `{ status: 'idle'\|'evaluating'\|'success'\|'error'; stageText?: string; error?: string; showPasteBox?: boolean; onSubmit(url: string, text?: string): void }` | Input (link icon), Button "Check", stage-text line, paste-textarea (needsText) | idle / evaluating (+ stage text) / success / invalid-URL error / needsText paste box |
| **EvalResultCard** | Single-URL verdict (F7) | `{ job: Job; onOpen(): void; onSave(): void; onTailor(): void; onDismiss(): void; alreadyKnownScopeLabel?: string }` | Card, ScoreBadge, FitBar, Tag (legitimacy foregrounded), EligibilityTag, Button×3 | verified / suspicious / scam / low-fit-high-legit / alreadyKnown / web-check-unavailable / loading skeleton |
| **SummaryStrip** | Hero stat row (§11.8) | `{ stats: ScanStats & { flagged: number; sinceLast: number } }` | Card (sunken), tabular numerals; flagged in `--accent-ink` | populated / zero-state / stale |
| **FilterChips** | Real feed filters (§11.8) | `{ active: FeedFilter; counts: Record<FeedFilter, number>; onChange(f): void }` | Chip row | each filter active / empty-count disabled |
| **JobRow** | The A·Signal-Pill row — hero unit | `{ job: Job; onOpen(): void; onSave(): void; onDismiss(): void }` | Card (hover lift) → ScoreBadge · title + Tag legitimacy + EligibilityTag (suppressed on `local`) + neutral schedule/structure Tag(s) (stated-only, remote-fit spec §11) + NewBadge · meta/why · IconButtons | 5 legitimacy tiers × isNew; eligibility anywhere/unverified/local-no-pill; schedule pill (EU/US hours) present/suppressed (apac/unstated); structure pill (Local entity/EOR/Contractor) present/absent; saved; dismissing; ghost (muted) |
| **JobFeed** (`FeedStream`) | Live scored feed (F2) | `{ jobs: Job[]; filter: FeedFilter; onFilterChange(f): void; stats: SummaryStripStats; loading: boolean; error?: string; onRowAction(id, action): void }` | SummaryStrip, FilterChips, JobRow[], "new since last visit" divider | loading skeleton / empty / empty-after-filter / error+retry / populated / all-flagged |
| **ScanProgress** | Market-scan overlay (F2) — *additive, spec §7*; renders the search-run SSE stream (`sources`→`fetch`→`score`→`legitimacy`) as four labelled stages. Prop shape is presentational (self-contained, not a contract entity), driven by `useScanRun` | `{ status: "running"\|"done"\|"error"; stages: {stage; label; state; current?; total?; detail?}[]; stats?: {scanned; worth; ghosts}; error?; onClose?() }` | Card overlay, progress bar, per-stage glyphs (check/spinner/pending) | running / done (honest scanned·worth·ghost summary + "View your matches") / error |
| **ScansList** | Scans hub list (`/scans`) — one card per past scan, wired to `GET /api/search`. Presentational; page owns fetch + navigation | `{ runs: SearchRunSummary[]; onOpen(id): void }` | Card per run → résumé name (click → `onOpen`), duration, verdict mix (`worth · ghost · scored`), status Tag (completed=good / failed=danger / `capStopped`=warn "Partial" / running=spin glyph) | populated / partial (cap-stopped) / failed / running |
| **ScanReplay** | Scan detail replay (`/scans/:id`, terminal run) — phased report from persisted `results`, wired to `GET /api/search/:id` JSON (`ScanDetail`) | `{ detail: ScanDetail }` | Header (résumé/persona/duration/`$costUsd`/policyVersion/status) + 3 `Card` sections: Discover (scanned/matched/discoverMs), Score (fit-sorted `results` list w/ re-sort control), Legitimacy (tier aggregate) | terminal (scored/unscored/error/skipped rows) / not-found |
| **SourceStrip** | Live discovery strip (`/scans/:id`, running run — M2) — one `Tag` per source connector, fed by the `useScanLive` reducer over the enriched SSE stream (`source` events) | `{ sources: SourceEventData[] }` | flex row of `Tag` (tone by status: fetching=neutral+`caliber-spin` / done=good / error=danger), `name` + found-count | fetching / done / error / mixed |
| **ScanLanes** | Live concurrency lanes (`/scans/:id`, running run — M2) — one lane per in-flight scoring job showing its real sub-phase, fed by `useScanLive` (`jobPhase`/`snapshot` events, client-assigned slots) | `{ activeJobs: LiveJob[]; counts: {scored;queued;total} }` | `Card` per lane (slot-sorted) → `StageGlyph` + `PHASE_LABEL` (Fetching/Reading JD/Scoring/Re-scoring) + title/company + `caliber-pulse`; counts row `{scored}/{total} · {queued} queued` | lanes active / counts row |
| **SourceList** | Sources management page (`/sources`) — per-source enable/disable list, wired to `GET /api/sources`/`PATCH /api/sources/:id` | `{ sources: Source[]; busyId?: string \| null; onToggle(id, enabled): void }` | Card×2 (persona groups "Remote · global" / "Malaysia · local"), Tag (kind ATS/Board), Button (toggle — no switch primitive exists; `aria-pressed` carries enabled state) | both persona groups populated / row busy (control disabled) / mixed enabled·disabled |
| **ProfileTargets** | Profile & targets page (`/profile`) — base country + relocation/schedule/employment dials, wired to `PUT /api/profile` (remote-fit spec 2026-07-14 §8). A "Which sounds like you?" preset row sets all three dials in one call; presets are derived, never stored — the dials are the only truth | `{ profile: Profile; busy: boolean; onRelocationChange(v): void; onScheduleChange(v): void; onEmploymentChange(v): void; onPresetSelect(bundle: { relocation; scheduleFlex; employmentPref }): void }` | Card, Select (base country), Chip×2/3/3 (three segmented pills, `filter` variant, `aria-pressed` carries selection — same pattern as SourceList's toggle), Card `interactive`×4 (preset tiles) | relocation stay/open; 3 schedule levels; 3 employment levels; a preset tile shows a derived selected ring when all three dials match its bundle; busy disables every control |
| **JobDetail** | Full posting view (F3/F4/F6 launcher) | `{ job: Job; applied?: Application; onApply(): void; onTailor(): void; onAnswerQuestions(): void; onMarkApplied(): Promise<void> }` | Card, Tabs (Fit·Legitimacy·Breakdown), FitBar[], Tag (incl. `job.tags` schedule/structure pills), Button (Apply=primary w/ external-link icon), AppliedButton | loading / populated / already-applied / scam-tier (Apply demoted, warning banner) / stated `workCalendar` gap row |
| **AppliedButton** | F5 mark-applied | `{ applied: boolean; appliedAgo?: string; onMarkApplied(): Promise<void> }` | Button ↔ Chip | idle / confirming / applied ("Applied · 2d ago", disabled) / error-retry |
| **ResumeUpload** | F1 ingest | `{ onFile(f: File): void; status: 'idle'\|'uploading'\|'parsing'\|'error'\|'done'; progress?; error? }` | Card (dashed dropzone), Icon, Button | idle / dragover / uploading / parsing / parse-error (retry + build) / done |
| **ResumeView** | Parsed structured résumé (F1) | `{ resume: Resume; onTailor?(): void; onReupload(): void }` | Card sections, ScoreBadge (atsScore), Tag (skills), Tabs | empty (embeds ResumeUpload) / populated / long / low-ATS |
| **ApplyQuestionsAssistant** | F4 — see §2 | `{ job: Job; resume: Resume; detected?: ApplicationQuestion[]; onSaveAnswers(a): void }` | Tabs, Input, Card, Button, IconButton, Tag, Chip | see §2 |
| **TailorResume** | F6 — see §3 | `{ job: Job; resume: Resume; onExport(): void; onSave(t): void }` | see §3 | see §3 |
| **Tracker** | F5 console table (treatment C) | `{ rows: Application[]; sort: SortSpec; onSort; onOpen(id); onLogUpdate(id) }` | Card table, ScoreBadge, Tag (statusTone), **StagePips** `{ stage: 0\|1\|2\|3 }`, Tabs (Active·Closed) | empty (CTA to feed) / populated / sorted / closed-only / tailored-flag row |
| **AppShellHeader** | §11.8 top row | `{ persona; onPersona; evalStatus; onEval; alertCount: number }` | PersonaToggle, UrlEvalBar, NotificationBell (IconButton + count) | default / evaluating / alerts>0 |

## 1a. Auth, onboarding & admin (multi-tenant additions)

Added by the auth-core + multi-tenant migration; not covered by the original spine §1–§4 design. Route groups: `(auth)` (login/register, chrome-free — no `AppShell`) vs `(app)` (session+profile-guarded, wrapped in `AppShell`) vs `(onboarding)` (session-guarded, profile-less only).

| Component | Purpose | Key props (TS) | Composes | States/variants |
|---|---|---|---|---|
| **AuthCard** | `(auth)` login/register form | `{ mode: 'login'\|'register'; onSubmit(email, password): void; busy: boolean; error?: string; switchHref: string; switchLabel: string }` | Card, Input×2, Button, Icon | login / register / busy / server error (shown verbatim, no client-side auth logic) |
| **OnboardingPage** (`(onboarding)/onboarding`) | Profile-less registrant's only reachable destination | local (unsaved) `Profile` state → `PUT /api/profile` (upsert) on Save → `/feed` | Card, `ProfileTargets`, Button | idle / busy / save error |
| **AppSidebar** | The real app shell's left nav, added by the migration — distinct from `AppShellHeader` below (feed page's top bar for persona/eval, unaffected by auth) | `{ user?: AuthUser; activeId?: string; onSelect?(id): void; onLogout?(): void }` | `SidebarNav`, **`ProfileChip`** (footer) | signed-out (no footer) / signed-in / admin (Admin section appended) |
| **ProfileChip** | Signed-in identity + logout affordance, sidebar footer | `{ user: AuthUser; onLogout?(): void }` | Avatar, IconButton | always the real session's email/role — never a placeholder name |
| **AdminUsersTable** | `/admin` roster — every account + per-user counts | `{ users: AdminUser[] }` | Card (table), Tag (role) | empty ("No users yet.") / populated |
| **AdminPage** (`(app)/admin`) | Wraps `AdminUsersTable`, calls `GET /api/admin/users` | — | AdminUsersTable, Button, Icon | loading / populated / error+retry / 403 forbidden ("You do not have access to this page.") — a non-admin who reaches the URL directly gets this state, not the generic error banner |
| **PoolFunctionCards** | Admin Pool tab — 12 function-bucket stat cards (spec 2026-07-21) | `{ mix: AdminPoolStats["functionMix"] }` | Card | populated (12 buckets, largest numeral in `--accent-ink`) |
| **PoolStrips** | Admin Pool tab — TZ band / freshness / company-concentration 100%-stacked strips | `{ tzBands; freshness; concentration }` | Chip (legends), FitBar-geometry bars | populated |
| **PoolPanel** (`(app)/admin/pool`) | Admin Pool tab body — tile row + PoolFunctionCards + PoolStrips, calls `GET /api/admin/pool` | `{ stats?: AdminPoolStats; loading: boolean; error?: string; onRetry?(): void }` | PoolFunctionCards, PoolStrips, Button, Icon, Card | loading skeleton / empty (pool empty) / error+retry / populated |

`AppShell` (`src/app/AppShell.tsx`) mounts `AppSidebar` around every `(app)` page, drives active-tab from the router pathname, and resets client-side stores (e.g. the url-check dock) when the signed-in user id changes between sessions. The **Admin** sidebar section (`ADMIN_SIDEBAR_ITEMS`: `admin-users` → `/admin`, `admin-crawl` → `/admin/crawl`, `admin-pool` → `/admin/pool`) is appended only when `user.role === 'admin'` — a non-admin never sees the nav entries, and every admin API still enforces `requireAdmin()` independently (defense in depth, not a second authorization system).

## 2. F4 — ApplyQuestionsAssistant (the novel piece)

**Flow:** intake → extract → review questions → draft → edit/copy. Launched from `JobDetail`; renders as a full page (`/jobs/[id]/questions`), not a modal — answers are long-form work.

**Intake (Tabs, 3 modes):** (a) **Detected** — a known-ATS form scraped by the scan service arrives pre-extracted (`detected` prop); intake skipped, "6 questions detected from Greenhouse" banner shown; (b) **Paste form** — user copy-pastes raw application-form text; (c) **Paste JD** — no form available; the LLM *infers likely* questions, each stamped with an `inferred` Tag.

**Extraction review:** parsed `ApplicationQuestion[]` render as an editable list — delete a mis-parse, edit prompt/`kind`/char-limit, or add manually. Then "Draft all answers" (or per-card).

**Answer cards:** one `AnswerCard` per question. Editable textarea seeded with the LLM draft; live char counter vs `maxLength`; **grounding chips** — each cites a résumé region (`Summary`, `Acme 2022–24 · bullet 3`), clicking scrolls a collapsible résumé side-rail to the source; sentences the model couldn't ground get a `warn` Tag "not found in résumé". Per-card: **Regenerate** (dropdown: shorter · more formal · more specific) and **Copy**. Footer: **Copy all** and save-to-Application.

```ts
interface ApplicationQuestion { id: string; prompt: string;
  kind: 'text'|'textarea'|'select'|'multiselect'|'boolean'|'file';
  options?: string[]; required: boolean; maxLength?: number }
interface ApplicationAnswer { questionId: string; prompt: string; answer: string;
  grounding: { source: 'experience'|'skills'|'summary'|'headline'; quote: string }[] }
```

```
┌ Answer application questions — Stripe · Platform Eng ────────────┐
│ [Detected ✓] [Paste form] [Paste JD]        6 questions found    │
│ ┌ Q1  Why Stripe? ─────────────── long · ≤600 ── [jd-inferred] ─┐│
│ │ ┌ textarea (editable draft) ─────────────────────┐  412/600   ││
│ │ └─────────────────────────────────────────────────┘           ││
│ │ grounded in: [Summary] [Acme 2022–24 · b3]  ⚠ 1 ungrounded    ││
│ │ [Regenerate ▾]                                       [Copy]   ││
│ └───────────────────────────────────────────────────────────────┘│
│ … Q2–Q6                                                          │
│ [Draft all]                          [Copy all]  [Save & mark ✓] │
└──────────────────────────────────────────────────────────────────┘
```

**Subcomponents:** `QuestionIntake`, `QuestionListEditor`, `AnswerCard`, `GroundingChips`, `ResumeRail`. **States:** no-intake idle · extracting · extract-failed (retry + manual-add) · review · drafting (per-card streaming) · per-card error · ready · edited-dirty · copied toast · inferred-vs-detected mix.

## 3. F6 — TailorResume: recommend **diff-review**, not split editor

**Recommendation: diff-review.** (1) the MVP interaction is *approve LLM changes*, not free-form authoring; (2) the kit already owns a split editor (Resume Builder) — duplicating it violates "one canon"; (3) diff-review makes grounding auditable — the product's trust posture (same muscle as F4). The split editor remains the Phase-C Resume Builder; TailorResume outputs into it.

**Breakdown:** `TailorControls` (emphasis chips from `job.gaps`/`fit`, "Generate") → `TailorReport` (the "measure" step — a `CorrelationReport` readout: two separate signals, semantic coverage + ATS keyword presence, never fused into one score; requirement rows grouped Buried→Met→Gap; a single "Rewrite to close these" CTA; segment bars via the local `SignalBar` helper) → `ChangeList` grouped by section → **`ChangeCard`** `{ change: TailorDiffEntry; onToggle(accept) }` (before/after text, one-line rationale, accept/reject) → `TailorPreview` (paper preview of accepted-only state) → `ExportBar` (accepted count · Save copy · Export PDF).

```ts
interface TailorDiffEntry { section: string; op: 'add'|'remove'|'modify';
  before?: string; after?: string; reason: string; requirement: string;
  target: { index: number | null; bulletIndex: number | null } }
interface TailoredResume { id: string; jobId: string; resumeId: string;
  status: 'queued'|'running'|'completed'|'failed';
  progress: { stage: string; current: number; total: number; label: string } | null;
  reportId: string | null;
  atsDelta: { before: number; after: number; total: number } | null;
  resume: Omit<Resume, 'id'|'rawText'> | null;
  diff: TailorDiffEntry[]; model: string; createdAt: string; completedAt: string | null }
```

**States:** configuring · generating (streaming skeleton) · review (n changes, m accepted) · all-rejected · generation-error · saved · exporting-PDF / PDF-error.

## 4. Storybook structure (§12: code is canon)

Fixtures: one `src/caliber-ui/fixtures/` module exporting **Zod-parsed** `jobs: Job[]` (all 5 legitimacy tiers, isNew, ghost), `resume`, `appliedRows`. Stories import only fixtures — a contract change breaks stories at parse time, which is the alignment test.

```
Tokens/            Colors · Typography · Radius&Space · Legitimacy tones (tier→tone→Tag matrix)
Primitives/        14 stories, one per primitive; every variant as Controls args
Compositions/
  Shell/           PersonaToggle · UrlEvalBar · NotificationBell · AppShellHeader
  Feed/            NewBadge · SummaryStrip · FilterChips · JobRow · JobFeed · ScanProgress
  Scans/           ScansList · ScanReplay · SourceStrip · ScanLanes
  Sources/         SourceList
  Eval/            EvalResultCard
  Resume/          ResumeUpload · ResumeView
  Apply/           AppliedButton · AnswerCard · GroundingChips · QuestionListEditor · ApplyQuestionsAssistant
  Tailor/          ChangeCard · TailorReport · TailorResume
  Tracker/         StagePips · TrackerTable
Pages/             Resume · Feed (hero A·Signal Pill) · JobDetail · ApplyAssistant · Tailor · Tracker
Explorations/
  FeedTreatments/  A-SignalPill (canon) … C-Console … H-WarningBanner (8 variants)
```

Per-story variants = the "states to story" columns above; every composition gets at minimum **loading / empty / error / populated**. Pages render on full fixtures with MSW-style stubbed service calls, giving the deployable click-through of Phase A.

**Explorations as variants, not throwaway files:** each of the 8 feed treatments is a story of the *same* `JobFeed`/`JobRow` with treatment-specific args/decorators. Treatment C's story is the Tracker table's ancestor; H's banner becomes the post-Gate-#2 enhancement toggle. Rejected treatments stay browsable in `Explorations/`, never deleted, never separate HTML.

**Status: deferred.** The 8 `Explorations/FeedTreatments/*` stories described above have not been built — only the canon `Compositions/Feed/JobFeed` (treatment A·Signal-Pill) and its Tracker-table descendant (treatment C, built directly as `Compositions/Tracker/TrackerTable`) exist in code. Building out the remaining rejected/exploratory treatments as browsable stories is post-MVP; do not build them as part of the MVP Storybook pass.

## 5. Alignment checklist

- `JobRow`/`JobFeed`/`EvalResultCard`/`JobDetail` consume `Job` verbatim (§5 + §11.8 + `applyUrl`).
- `Tracker` consumes `Application` (`stage 0–3`, `statusTone`, `tailored`) — status folding stays in `features/applied/status-map.ts`.
- `ResumeView`/`ResumeUpload` consume `Resume` (`hasResume` drives empty state; `atsScore` → ScoreBadge).
- New contract types to freeze: `ApplicationQuestion`, `ApplicationAnswer`, `TailorDiffEntry`, `TailoredResume` — Zod-first, OpenAPI-generated.
- Missing required fields throw at the Zod boundary; components assume valid data.
