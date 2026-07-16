# Caliber — project instructions

Caliber is a standalone AI job-search + application-tracking web app (Next.js 15 App Router, React 19, TypeScript). **Code-led, design-as-stakeholder, single-operator MVP.** Built by re-aiming and extracting logic from a donor repo.

## Read before you touch anything (authoritative — do not contradict, do not invent around)
- `docs/superpowers/specs/2026-07-11-caliber-standalone-design.md` — product design, decisions, niche (§11), hero page A·Signal Pill (§11.8), tooling (§12).
- `docs/architecture/README.md` — index + reconciliations.
- `docs/architecture/system-architecture.md` — data model, services, flows.
- `docs/architecture/api-contract.md` — the Zod/OpenAPI contract (canonical entity shapes).
- `docs/architecture/component-inventory.md` — components + Storybook tree.

**If a fact isn't in these docs or the code, it is UNKNOWN — say so.** Do not invent endpoints, component names, entity fields, or donor behaviour. When unsure, read the file. This project spans multiple sources (a design kit, a donor repo, these specs); guessing across them is the main hallucination risk.

## The donor — CODE DONOR ONLY
`/Users/hakeem/Projects/career-ops/careerops-web` is a mature open-source job-search agent we EXTRACT logic from. It is **NOT a runtime dependency, NOT the design to copy, NOT the architecture to mirror.** Reuse its proven logic (résumé extraction, ATS scanning, eval + legitimacy scoring, apply-assistant, tracker, tailor) **rebuilt clean**. Never port its job engine, CLI-subprocess workers (`claude -p`), or markdown file-plane.

### Corrections to "common knowledge" about the donor (avoid these specific hallucinations)
- The donor has **NO `scan_jobs` DB table** — scan state was a TSV file. We build a fresh `jobs` table.
- There is **NO separate `verdict/verdict.ts` module** — legitimacy (Block G) lives *inside* the eval scoring.
- The donor **REJECTS `.docx`** — we add `mammoth`.
- **LaTeX is DROPPED** — tailoring emits résumé JSON + a changes list; PDF via Playwright.

## Canon
- **Design system:** the 13 primitives in `src/caliber-ui/components` + kit tokens in `src/caliber-ui/styles/tokens.css` (the approved "what you saw" values: cool ground `--bg-app #f6f7fb`, soft radii, red accent `#e8482b`). Compose them; never reinvent. Legitimacy is *semantic* colour, kept separate from the red brand accent.
- **Contract:** **Zod schemas in `src/types` are the single source of truth** → OpenAPI → docs. Key entities: `Job` (has `applyUrl`, `legitimacy` 5-tier, `source`, `persona`, `firstSeen`, `isNew`), `Resume`, `Application` (tracker record; the kit's `applied[]`), `ApplicationQuestion` / `ApplicationAnswer(s)`, `TailoredResume`, `SearchRun`, `SourceRef`. Do not add fields absent from the contract without updating it.
- **Legitimacy tiers:** `verified | clear | suspicious | ghost | scam`. Tracker status folding to the 4-stage pipeline lives in `features/applied/status-map.ts`.

## Architecture rules
- **Layering:** UI → `features/*` → `server/*`. Only `server/*` touches the DB or the LLM.
- **LLM:** OpenRouter only (OpenAI-compatible), cheapest viable model per task, template-guided (`config/models.yml`). No `claude -p` subprocesses.
- **Persistence:** Drizzle + SQLite via libsql (embedded file locally; Turso-ready). **Fail loud** — validate at boundaries (`Schema.parse`); no fallback defaults, no silent `0`/`""`/`unknown`.
- **Storybook is the component/page gallery** (`npm run storybook`). Figma is deferred; code is canon.

## Product
Niche: Malaysian/SEA professionals seeking remote/global roles **+** Malaysia-local, launched together. Wedge: fit + **legitimacy** (ghost/scam detection) foregrounded — no incumbent tracker leads with it. Lifelong tracker = retention. Template optimisation = an internal quality engine, not a user-facing headline.

## Working style
- Subagent roles on this project: **Fable** = deep thinking, design, review. **Sonnet** = building/implementation.
- Small surgical diffs, match existing style, no speculative abstractions. Ground every claim in the docs/code above.
