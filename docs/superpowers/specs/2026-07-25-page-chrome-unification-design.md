# Page chrome unification — design

**Date:** 2026-07-25
**Status:** approved, pre-implementation
**Scope:** the 11 routes under `src/app/(app)`. Chrome only — no page's content composition changes.
**Mockups:** https://claude.ai/code/artifact/66f11e12-4b20-4105-8a02-18df7438305c

## 1. Problem

No component owns the page frame, so each of the 11 app routes invented one. The result reads as
several applications sharing a sidebar.

**1.1 Page-identity split.** Five routes (`/tracker`, `/profile`, `/sources`, `/admin`,
`/jobs/[id]/tailor`) render a `<header>` bar containing a hard-coded "Caliber" wordmark plus a grey
subtitle — copy-pasted markup, not a component, duplicated across five files. The brand is therefore
stated twice on screen: once in `AppSidebar`, once 40px to its right. The page's actual name is
demoted to supporting text.

The other six routes (`/feed`, `/resume`, `/scans`, `/scans/[id]`, `/jobs/[id]`,
`/jobs/[id]/questions`) render no page title at all. `/scans` comes closest with a bare
`<span style={{font:"var(--type-h2)"}}>Scans</span>`.

**1.2 Four content widths, three of them dead.** `var(--content-max)` (7 routes) ·
`var(--content-max, 900px)` (`/scans/[id]`, `/jobs/[id]`) · `var(--content-max, 960px)`
(`/jobs/[id]/questions`) · hard-coded `maxWidth: 760` (`/resume`). Because `--content-max` is always
defined, the 900px and 960px fallbacks never fire — three authors recorded three different
intentions and all three render at 1120px. Only `/resume`'s 760 takes effect, by bypassing the token
system entirely.

**1.3 Padding ownership is split.** Seven routes put `padding: 24` on the inner max-width div; four
(`/resume`, `/scans/[id]`, `/jobs/[id]`, `/jobs/[id]/questions`) put it on the outer `100vh` div.

**1.4 No vertical rhythm.** No page stacks sections with CSS `gap` except one branch of
`/scans/[id]`. Everything else uses hand-written margins: `12` on `/resume`, `16` on `/profile` and
`/sources`, `32` between `/admin`'s sections.

**1.5 Four error banners, and blank-screen loading.** The error treatments are: icon + text + inline
Retry at `marginBottom:16` (`/profile`, `/sources`, `/admin`); the same at `marginBottom:12`
(`/resume`); icon + text with Retry *below* via `marginTop:12` (`/scans/[id]`, `/jobs/[id]`,
`/jobs/[id]/questions`); and bare red text with no icon and no retry (`/scans`). `/tracker` has no
error handling at all — `load()` has no try/catch.

Loading is `return null` — a blank screen — on `/resume`, `/scans/[id]`, `/jobs/[id]`,
`/jobs/[id]/questions`, `/jobs/[id]/tailor`, and effectively `/sources` and `/admin`. Only `/scans`
renders anything (`Loading…`). This is the most visible defect in the audit and the cheapest to fix.

**1.6 Redundant viewport nesting.** `AppShell` renders `<main style={{flex:1, overflow:"auto",
height:"100vh"}}>`, and every page then opens with its own `minHeight:"100vh"` + `background:
var(--bg-app)` div inside it — a full viewport nested in a full viewport, with the app background
painted twice.

**1.7 `/feed` has diverged from its own canon.** `AppShellHeader` exists at
`compositions/Shell/AppShellHeader.tsx` and is the `Pages/Feed` Storybook reference, but the real
`/feed` page re-implements that row inline. The composition is referenced only by its own story.

**Not in scope.** The `(auth)` and `(onboarding)` route groups sit outside `AppShell`, use a
deliberate chrome-free centered layout, and are internally consistent. They are untouched.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Scope | Chrome unification only. No page's content composition is re-laid-out. |
| D2 | Where the components live | `src/caliber-ui/compositions/Shell/` — **not** `components/`. The "14 primitives" canon in `component-inventory.md` stands. |
| D3 | Header placement | In-flow, inside the content column. The `<header>` bar is deleted from all five routes that have one. |
| D4 | Title scale | `--type-h1` (31px/700) with `--tracking-tighter`. No closing hairline rule. |
| D5 | Content widths | Two, named: `wide` = `--content-max` (1120px), `reading` = `--content-reading` (760px, new token). |
| D6 | Vertical rhythm | `PageContainer` owns it via flex `gap`. Default 24, `gap="tight"` = 16. No page writes a vertical margin between sections. |
| D7 | Loading | Skeletons that hold layout. Not text, not blank. |
| D8 | Back links | `backTo` eyebrow on all four detail routes. |
| D9 | Error banner | The inline-retry form (`/profile`/`/sources`/`/admin`) becomes canonical; the other three are deleted. |
| D10 | `/feed` summary numbers | Stay in `SummaryStrip` inside `JobFeed`, per §11.8. The header does **not** duplicate them — `/feed` gets a title and no `meta`. Moving the strip would be a content re-layout, excluded by D1. |

### 2.1 Rejected

- **AppShell owns the chrome via a route→title map.** Three routes have dynamic titles
  (`/jobs/[id]`, `/jobs/[id]/tailor`, `/scans/[id]`), which a static map cannot serve without a
  title context or override hook. Trades explicit props for hidden machinery.
- **A single `<Page>` wrapper** taking `title`/`loading`/`error`/`empty`/`children`. Pages disagree
  on where state lives: `/feed` and `/jobs/[id]/tailor` delegate error to their composition,
  `/admin` has two independent error banners, `/scans/[id]` has a not-found state distinct from its
  error state. One prop API would need escape hatches for all of them.
- **One width everywhere (1120px).** Stretches the résumé upload card and the password form past
  comfortable reading measure.
- **A hairline rule under the header.** On card-led pages it puts a rule directly above another rule.
  Revisit only if a page lands whose first element is a bare table or chart.

## 3. Components

Three new files under `src/caliber-ui/compositions/Shell/`, each with a `.stories.tsx` sibling, all
added to the compositions barrel export.

### 3.1 `PageHeader.tsx`

```ts
type PageHeaderProps = {
  title: string;
  backTo?: { href: string; label: string };
  meta?: ReactNode;
  actions?: ReactNode;
};
```

Layout: a flex row. Left column stacks `backTo` eyebrow → `title` → `meta`; `actions` sit
right-aligned to the content edge, top-aligned with the title.

- `title` — `<h1>`, `font: var(--type-h1)`, `letter-spacing: var(--tracking-tighter)`,
  `color: var(--text-strong)`.
- `backTo` — `next/link`, `font: var(--type-caption)`, `color: var(--text-muted)`, arrow-left icon
  at 13px, hover and focus-visible → `var(--accent-ink)`. Rendered above the title, `margin-bottom: 8`.
- `meta` — `font: var(--type-body)`, `color: var(--text-muted)`, `margin-top: 7`. Callers pass
  their own nodes; numerals inside must carry `font-variant-numeric: tabular-nums`.
- `actions` — flex row, `gap: 8`, `padding-top: 5` for optical alignment with the 31px title.

Exactly one `<h1>` per page. Compositions that currently render their own top-level heading must
step down or drop it — checked per page during the retrofit.

### 3.2 `PageContainer.tsx`

```ts
type PageContainerProps = {
  width?: "wide" | "reading";   // default "wide"
  gap?: "default" | "tight";    // default "default" (24) | "tight" (16)
  children: ReactNode;
};
```

Renders a single div: `max-width` from the width token, `margin: 0 auto`, `padding: 24`,
`display: flex`, `flex-direction: column`, `gap` from the gap token. It does **not** render
`minHeight: 100vh` or a background — `AppShell` already owns both (§1.6).

`PageHeader` is passed as the first child, so header-to-content spacing is the container's `gap`.

New token in `src/caliber-ui/styles/tokens.css`, beside `--content-max`:

```css
--content-reading: 760px;   /* forms and documents; comfortable measure */
```

### 3.3 `PageState.tsx`

Three named exports. Denied and not-found are `PageEmpty` with different props — not their own
components.

```ts
type PageLoadingProps  = { variant: "list" | "form"; rows?: number };            // rows default 3
type PageErrorProps    = { message: string; onRetry?: () => void };
type PageEmptyProps    = { icon: IconName; title: string; body: string; action?: ReactNode };
```

- **`PageLoading`** — `variant="list"` renders a title block plus `rows` skeleton rows matching the
  feed/list row shape (44px circle + two lines). `variant="form"` renders a title block plus stacked
  field-height blocks. Fills use `--surface-sunken` on `--surface`; the shimmer sweep is suppressed
  under `prefers-reduced-motion: reduce`.
- **`PageError`** — the canonical banner: `background: var(--danger-soft)`,
  `color: var(--danger-ink)`, `border-radius: var(--radius-sm)`, `padding: 10px 14px`,
  `triangle-alert` icon + message on the left, `Button variant="secondary" iconLeft="refresh-cw"`
  inline on the right when `onRetry` is passed.
- **`PageEmpty`** — centered column on a `Card`-equivalent surface: icon at `--text-faint` 24px,
  `title` at `--type-h3` / `--text-strong`, `body` at `--type-body` / `--text-muted` capped near 44ch,
  optional action. Neutral surface, never `--danger-soft` — an empty result is not an error.

Copy rules for `PageError` and `PageEmpty`: state what happened and what to do next; no apologies,
no bare exception text.

## 4. Retrofit

| Route | Title | Width | Also |
|---|---|---|---|
| `/feed` | `Feed` | wide | Replace the inline header row with `AppShellHeader` (the existing composition). No `meta` — `SummaryStrip` keeps the numbers (D10). |
| `/scans` | `Scans` | wide | `PageLoading variant="list"` replaces `Loading…`; bare-red error → `PageError`. |
| `/scans/[id]` | run name, `backTo` → `/scans` "Scans" | wide | Keeps its not-found state, now `PageEmpty`. |
| `/resume` | `Résumé` | **reading** | Hard-coded `760` → `--content-reading`. Two duplicate error banners → one `PageError`. |
| `/tracker` | `Application tracker` | wide | Gains loading and error states it has none of today — `load()` needs a try/catch and an error flag. |
| `/profile` | `Profile & targets` | **reading** | Gains `PageLoading variant="form"`. |
| `/sources` | `Sources` | wide | `PageLoading variant="list"` replaces blank. |
| `/jobs/[id]` | role, `backTo` → `/feed` "Feed" | **reading** | Split `return null` into loading vs not-found. |
| `/jobs/[id]/questions` | `Application answers`, `backTo` → the job | **reading** | Bare `<p>` empty state → `PageEmpty` with an "Upload résumé" action. |
| `/jobs/[id]/tailor` | `Tailor résumé`, `backTo` → the job | **reading** | Header inverts: the task becomes the title, the job becomes the link. |
| `/admin` | `Admin` | wide | Forbidden state → `PageEmpty` (shield icon, no action). Keeps both error banners — the second is a sub-panel error, not a page error. |

Deleted across the sweep:

1. The duplicated `<header>` + wordmark block in 5 files.
2. The dead `var(--content-max, 900px)` and `var(--content-max, 960px)` fallbacks.
3. `/resume`'s hard-coded `maxWidth: 760`.
4. Every page's `minHeight: "100vh"` + `background: var(--bg-app)` wrapper (§1.6).
5. Three of the four error-banner variants.

## 5. Testing

- **Storybook** — a story per component covering every variant: `PageHeader` × {title only, title +
  meta, title + actions, backTo + title + meta + actions}; `PageContainer` × {wide, reading, tight};
  `PageState` × {loading list, loading form, error with retry, error without, empty with action,
  empty without}.
- **Unit (vitest)** — `PageHeader` renders exactly one `<h1>`; `backTo` renders a link with the given
  href and label, and renders nothing when the prop is absent; `PageError` renders the retry button
  only when `onRetry` is passed and calls it on click.
- **Regression** — the existing `Pages/*` stories must still render. `/feed` switching to
  `AppShellHeader` is the one change with real regression surface: the inline row and the
  composition must be diffed prop-by-prop before the swap.
- **Gate** — `npm run check` (typecheck + vitest + `contract:check` + build) green before merge.
  No contract change is expected; these components take no entity types.

## 6. Risks

- **`/feed` header swap.** The inline row may have drifted from `AppShellHeader` in ways beyond
  layout (handlers, props, notification wiring). If the diff shows behavioural drift, reconcile the
  composition to match the shipped page — the page is the source of truth for behaviour, the
  composition for layout.
- **Double headings.** Some compositions render their own top-level title (`JobDetail` shows the
  role; `/admin` has a "Sources health" `--type-h3` section title). Each retrofitted page needs a
  check that adding `PageHeader` doesn't produce two competing titles.
- **`/tracker` has no error path today.** Adding one means adding a try/catch and state to a
  component that currently has neither. Small, but it is the one page where this work adds
  behaviour rather than only moving markup.
- **`--content-reading` on `/jobs/[id]`.** Job detail may currently rely on the full 1120px for a
  two-column layout. Verify against `JobDetail` before switching it to `reading`; if it is
  two-column, it stays `wide` and this table row changes.
