# Caliber — agent instructions

Self-contained grounding for any agent/tool. Full detail in `CLAUDE.md` (read it) and `docs/`.

**What this is:** a standalone AI job-search + application-tracking app (Next.js 15 + React 19 + TS). Code-led, single-operator MVP.

**Authoritative docs — read before acting; do not invent around them:**
`docs/superpowers/specs/2026-07-11-caliber-standalone-design.md`, `docs/architecture/{README,system-architecture,api-contract,component-inventory}.md`.
If a fact isn't in the docs or code, it is UNKNOWN — say so; never fabricate endpoints, components, fields, or donor behaviour.

**Donor:** `/Users/hakeem/Projects/career-ops/careerops-web` is a CODE DONOR ONLY — extract its logic, rebuild clean; not a runtime dep, not the design. Do NOT hallucinate donor facts: it has no `scan_jobs` table (was a TSV), no separate `verdict/verdict.ts` (legitimacy is inside eval scoring), it rejects `.docx` (add `mammoth`), and LaTeX is dropped.

**Canon:**
- Design system = 13 primitives in `src/caliber-ui/components` + kit tokens in `src/caliber-ui/styles/tokens.css` ("what you saw": cool ground, soft radii, red accent). Compose, don't reinvent. Legitimacy colour is semantic, separate from the red accent.
- Contract = Zod schemas in `src/types` (single source of truth → OpenAPI). Entities: `Job` (incl. `applyUrl`, 5-tier `legitimacy`), `Resume`, `Application`, `ApplicationQuestion/Answer`, `TailoredResume`, `SearchRun`.
- Legitimacy tiers: `verified | clear | suspicious | ghost | scam`.

**Rules:** UI → `features/*` → `server/*` (only `server/*` touches DB/LLM). LLM via OpenRouter only, template-guided, cheapest viable. Drizzle+Postgres (SQLite dev). Fail loud; validate at boundaries; no fallback defaults. Storybook is the gallery; Figma deferred.

**Product wedge:** fit + legitimacy (ghost/scam) scoring, foregrounded; remote-global + Malaysia-local at launch.

**Subagent roles:** Fable thinks/designs/reviews; Sonnet builds.
