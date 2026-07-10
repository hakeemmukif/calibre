# Caliber MVP — Component Inventory & Storybook Blueprint

Grounded in spec §4/§5/§11.4/§11.8/§12. Everything composes the 13 primitives; nothing reinvents them.

## 0. Contract notes (read first)

All compositions take **whole contract objects** (`Job`, `Resume`, `Application`), never exploded scalars — props stay aligned with `src/types` by construction. Notes:

- The tracker record is the entity **`Application`** (Drizzle `applications`); it is what the kit surfaced as `applied[]`.
- **`applyUrl: string` is required by F3 but absent from §5** — added to `Job` at contract-freeze. Same for the F4/F6 types (`ApplicationQuestion`, `DraftedAnswer`, `TailorChange`), which are net-new contract additions.

```ts
type Persona = 'remote' | 'local';
type LegitTier = 'verified'|'clear'|'suspicious'|'ghost'|'scam';
interface Legitimacy { tier: LegitTier; tone: 'verified'|'good'|'warn'|'ghost'|'danger'; summary: string; confidence?: number }
// Job (§5) extended per §11.8 + F3:
interface Job { /* §5 fields */; legitimacy: Legitimacy; applyUrl: string; source: string; persona: Persona; firstSeen: string; isNew: boolean }
```

Tier→tone mapping lives in exactly one place (`legitimacyTone(tier)`); components render `Tag` from it — never hand-pick tones. No fallback rendering: a `Job` missing `legitimacy` throws in the Zod boundary, not defaults to grey.

## 1. Component inventory

`NewBadge` is the one new near-primitive (a styled `Chip`-sized dot+label; props `{ label?: string }`).

| Component | Purpose | Key props (TS) | Composes | States/variants to story |
|---|---|---|---|---|
| **PersonaToggle** | Switch source-set/language presets | `{ value: Persona; onChange(v): void; disabled?: boolean }` | Chip×2 (segmented pill) | remote / local / disabled |
| **UrlEvalBar** | Paste-URL front door (F2) | `{ onSubmit(url): void; status: 'idle'\|'evaluating'\|'error'; error?: string }` | Input (link icon), Button "Check" | idle / evaluating / invalid-URL error |
| **EvalResultCard** | Single-URL verdict | `{ job: Job; onOpen(): void; onSave(): void }` | Card, ScoreBadge, FitBar, Tag (legitimacy foregrounded), Button | verified / suspicious / scam / low-fit-high-legit / loading skeleton |
| **SummaryStrip** | Hero stat row (§11.8) | `{ stats: ScanStats & { flagged: number; sinceLast: number } }` | Card (sunken), tabular numerals; flagged in `--accent-ink` | populated / zero-state / stale |
| **FilterChips** | Real feed filters (§11.8) | `{ active: FeedFilter; counts: Record<FeedFilter, number>; onChange(f): void }` | Chip row | each filter active / empty-count disabled |
| **JobRow** | The A·Signal-Pill row — hero unit | `{ job: Job; onOpen(): void; onSave(): void; onDismiss(): void }` | Card (hover lift) → ScoreBadge · title + Tag legitimacy + NewBadge · meta/why · IconButtons | 5 legitimacy tiers × isNew; saved; dismissing; ghost (muted) |
| **JobFeed** (`FeedStream`) | Live scored feed (F2) | `{ jobs: Job[]; filter: FeedFilter; loading: boolean; error?: string; onRowAction(id, action): void }` | SummaryStrip, FilterChips, JobRow[], "new since last visit" divider | loading skeleton / empty / empty-after-filter / error+retry / populated / all-flagged |
| **JobDetail** | Full posting view (F3/F4/F6 launcher) | `{ job: Job; detail: MatchDetail; applied?: Application; onApply(): void; onTailor(): void; onAnswerQuestions(): void }` | Card, Tabs (Fit·Legitimacy·Breakdown), FitBar[], Tag, Button (Apply=primary w/ external-link icon), AppliedButton | loading / populated / already-applied / scam-tier (Apply demoted, warning banner) |
| **AppliedButton** | F5 mark-applied | `{ applied: boolean; appliedAgo?: string; onMarkApplied(): Promise<void> }` | Button ↔ Chip | idle / confirming / applied ("Applied · 2d ago", disabled) / error-retry |
| **ResumeUpload** | F1 ingest | `{ onFile(f: File): void; status: 'idle'\|'uploading'\|'parsing'\|'error'\|'done'; progress?; error? }` | Card (dashed dropzone), Icon, Button | idle / dragover / uploading / parsing / parse-error (retry + build) / done |
| **ResumeView** | Parsed structured résumé (F1) | `{ resume: Resume; onTailor?(): void; onReupload(): void }` | Card sections, ScoreBadge (atsScore), Tag (skills), Tabs | empty (embeds ResumeUpload) / populated / long / low-ATS |
| **ApplyQuestionsAssistant** | F4 — see §2 | `{ job: Job; resume: Resume; detected?: ApplicationQuestion[]; onSaveAnswers(a): void }` | Tabs, Input, Card, Button, IconButton, Tag, Chip | see §2 |
| **TailorResume** | F6 — see §3 | `{ job: Job; resume: Resume; onExport(): void; onSave(t): void }` | see §3 | see §3 |
| **Tracker** | F5 console table (treatment C) | `{ rows: Application[]; sort: SortSpec; onSort; onOpen(id); onLogUpdate(id) }` | Card table, ScoreBadge, Tag (statusTone), **StagePips** `{ stage: 0\|1\|2\|3 }`, Tabs (Active·Closed) | empty (CTA to feed) / populated / sorted / closed-only / tailored-flag row |
| **AppShellHeader** | §11.8 top row | `{ persona; onPersona; evalStatus; onEval; alertCount: number }` | PersonaToggle, UrlEvalBar, NotificationBell (IconButton + count) | default / evaluating / alerts>0 |

## 2. F4 — ApplyQuestionsAssistant (the novel piece)

**Flow:** intake → extract → review questions → draft → edit/copy. Launched from `JobDetail`; renders as a full page (`/jobs/[id]/questions`), not a modal — answers are long-form work.

**Intake (Tabs, 3 modes):** (a) **Detected** — a known-ATS form scraped by the scan service arrives pre-extracted (`detected` prop); intake skipped, "6 questions detected from Greenhouse" banner shown; (b) **Paste form** — user copy-pastes raw application-form text; (c) **Paste JD** — no form available; the LLM *infers likely* questions, each stamped with an `inferred` Tag.

**Extraction review:** parsed `ApplicationQuestion[]` render as an editable list — delete a mis-parse, edit prompt/`kind`/char-limit, or add manually. Then "Draft all answers" (or per-card).

**Answer cards:** one `AnswerCard` per question. Editable textarea seeded with the LLM draft; live char counter vs `constraints.maxChars`; **grounding chips** — each cites a résumé region (`Summary`, `Acme 2022–24 · bullet 3`), clicking scrolls a collapsible résumé side-rail to the source; sentences the model couldn't ground get a `warn` Tag "not found in résumé". Per-card: **Regenerate** (dropdown: shorter · more formal · more specific) and **Copy**. Footer: **Copy all** and save-to-Application.

```ts
interface ApplicationQuestion { id: string; jobId: string; prompt: string;
  kind: 'short'|'long'|'select'|'boolean';
  constraints?: { maxChars?: number; options?: string[] };
  source: 'ats-detected'|'pasted-form'|'jd-inferred' }
interface DraftedAnswer { questionId: string; text: string;
  citations: { section: string; ref: string; excerpt: string }[];
  ungrounded: string[]; status: 'drafting'|'ready'|'edited'|'error' }
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

**Breakdown:** `TailorControls` (emphasis chips from `job.gaps`/`fit`, "Generate") → `ChangeList` grouped by section → **`ChangeCard`** `{ change: TailorChange; onToggle(accept) }` (before/after text, one-line rationale, accept/reject) → `TailorPreview` (paper preview of accepted-only state) → `ExportBar` (accepted count · Save copy · Export PDF).

```ts
interface TailorChange { id: string; section: string; op: 'rewrite'|'add'|'remove'|'reorder';
  before?: string; after?: string; rationale: string; accepted: boolean }
interface TailoredResume { jobId: string; baseResumeId: string; changes: TailorChange[];
  status: 'generating'|'review'|'saved'|'exported' }
```

**States:** configuring · generating (streaming skeleton) · review (n changes, m accepted) · all-rejected · generation-error · saved · exporting-PDF / PDF-error.

## 4. Storybook structure (§12: code is canon)

Fixtures: one `src/caliber-ui/fixtures/` module exporting **Zod-parsed** `jobs: Job[]` (all 5 legitimacy tiers, isNew, ghost), `resume`, `appliedRows`. Stories import only fixtures — a contract change breaks stories at parse time, which is the alignment test.

```
Tokens/            Colors · Typography · Radius&Space · Legitimacy tones (tier→tone→Tag matrix)
Primitives/        13 stories, one per primitive; every variant as Controls args
Compositions/
  Shell/           PersonaToggle · UrlEvalBar · NotificationBell · AppShellHeader
  Feed/            NewBadge · SummaryStrip · FilterChips · JobRow · JobFeed
  Eval/            EvalResultCard
  Resume/          ResumeUpload · ResumeView
  Apply/           AppliedButton · AnswerCard · GroundingChips · QuestionListEditor · ApplyQuestionsAssistant
  Tailor/          ChangeCard · TailorResume
  Tracker/         StagePips · TrackerTable
Pages/             Resume · Feed (hero A·Signal Pill) · JobDetail · ApplyAssistant · Tailor · Tracker
Explorations/
  FeedTreatments/  A-SignalPill (canon) … C-Console … H-WarningBanner (8 variants)
```

Per-story variants = the "states to story" columns above; every composition gets at minimum **loading / empty / error / populated**. Pages render on full fixtures with MSW-style stubbed service calls, giving the deployable click-through of Phase A.

**Explorations as variants, not throwaway files:** each of the 8 feed treatments is a story of the *same* `JobFeed`/`JobRow` with treatment-specific args/decorators. Treatment C's story is the Tracker table's ancestor; H's banner becomes the post-Gate-#2 enhancement toggle. Rejected treatments stay browsable in `Explorations/`, never deleted, never separate HTML.

## 5. Alignment checklist

- `JobRow`/`JobFeed`/`EvalResultCard`/`JobDetail` consume `Job` verbatim (§5 + §11.8 + `applyUrl`).
- `Tracker` consumes `Application` (`stage 0–3`, `statusTone`, `tailored`) — status folding stays in `features/applied/status-map.ts`.
- `ResumeView`/`ResumeUpload` consume `Resume` (`hasResume` drives empty state; `atsScore` → ScoreBadge).
- New contract types to freeze: `ApplicationQuestion`, `DraftedAnswer`, `TailorChange`, `TailoredResume` — Zod-first, OpenAPI-generated.
- Missing required fields throw at the Zod boundary; components assume valid data.
