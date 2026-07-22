# Repo reorganization report — branch `reorg/claude-onboarding`

Date: 2026-07-22. Author: Claude Code (Fable orchestrating Sonnet workers). Method: measured, not vibes — a fresh cold-start session answered the same 7 onboarding questions before and after the reorg, counting tool calls and logging frictions.

## Result

| Metric | Before (main) | After (this branch) |
|---|---|---|
| Cold-start tool calls to answer 7 onboarding questions | 21 | 15 (−29%) |
| Actively-misleading doc claims hit during onboarding | 5 (Postgres ×3, pre-cutover pipeline, stale snapshots) | 0 |
| Entry point for a newcomer | none (no root README) | `README.md` |
| Checked-in Claude Code config | 2 skills only | skills + `CLAUDE.md` commands + `AGENTS.md` fixed + `.claude/settings.json` |

Every friction in the baseline top-5 was eliminated; the re-test surfaced a smaller residual set, fixed in the final polish commit on this branch.

## What the baseline found (why these changes)

1. **The docs lied about the database.** `docs/architecture/README.md`, `runbook.md`, and `AGENTS.md` all claimed Postgres; the app has been SQLite/libsql everywhere since 2026-07-16. A literal reader goes hunting for a database that doesn't exist.
2. **The canonical architecture doc described a dead pipeline.** `system-architecture.md` F2 still had per-scan connector fan-out; the shipped design (2026-07-17) is a nightly crawl filling a shared `postings` pool that scans read. Reconstructing the truth required reading source.
3. **No root README** — no orientation point for humans or non-Claude agents.
4. **20 dated specs with no current-vs-superseded index.**
5. **~25 npm scripts with no dev-vs-cron grouping** — nothing says `crawl:once` is a production cron entry, not a dev command.
6. Config gaps: `CLAUDE.md` never mentioned `npm run check`/`dev`/`test`/`db:migrate`; the `verify` skill's boot recipe was Postgres-era; no `.claude/settings.json` existed at all.

## What changed (commits on this branch)

- 5faa0c7 `docs: align architecture docs with shipped code (SQLite, postings pool, contract snapshots)` — Postgres→SQLite in architecture README + runbook; F2 rewritten to the pool pipeline; missing tables (`postings`, `crawl_runs`, `credit_ledger`, `correlation_reports`) and services (`server/sources`, `server/credits`, `server/pool`) documented; `api-contract.md` snapshots regenerated against `src/types` (Resume, ErrorCode 15, AdminUser, SseEvent 7, ScanStats, 9 missing endpoints); `component-inventory.md` fixed (Persona incl. `pasted`, real `ApplicationAnswer`/`TailorDiffEntry` shapes, 14 primitives).
- bc2be55 `docs: add specs provenance index + root README` — `README.md` (what/quickstart/commands-by-purpose/architecture-in-6-lines/doc-map/production); `docs/superpowers/README.md` (all 20 specs: CURRENT / SUPERSEDED / SHIPPED-as-code table).
- 4b13622 `chore(claude): commands block, AGENTS.md fixes, settings allowlist, verify-skill SQLite recipe` — `CLAUDE.md` Commands section (incl. the `db:migrate` `.env.local` drift gotcha), 13→14 primitives; `AGENTS.md` Postgres claim fixed + commands block; `.claude/settings.json` read-only/test allowlist; `verify` skill rewritten psql→sqlite3.
- Final polish commit — design-spec staleness banner (Job shape + primitive count), README↔runbook cross-links, dangling donor `compose-report.ts` reference fixed, "Where things live" table.

## Folder reorganization: what moved and what deliberately didn't

The measured onboarding cost was **doc drift, not folder layout** — the `caliber-ui → features → server` layering is real and legible in the tree. So code moves are zero. Considered and rejected:

| Candidate move | Why rejected |
|---|---|
| `DEPLOY.md`, `Dockerfile`, `docker-compose.yml`, `Caddyfile` → `deploy/` | Tool conventions + the `box` skill and push-to-deploy flow reference root paths; churn with no measured onboarding gain |
| Rename `contract/` (generated) vs `src/contract/` (generator) collision | Touches generator, `contract:check` CI gate, and the `/api/docs` route for a cosmetic win |
| Rename `caliber-ui/` → `ui/`; move `src/lib` server-only PDF code into `server/` | Mass import rewrites; layering is already documented instead |
| Archive `docs/superpowers/` dated files into `docs/archive/` | Breaks links from memories/plans; an index (`docs/superpowers/README.md`) achieves the same clarity without moving provenance |

Local-disk note (not a repo change): `.claude/worktrees/` holds ~4.3 GB of stale agent worktrees — reclaim with `git worktree prune` + deleting stale dirs when convenient.

## Architecture-equivalent folders: the recommendation

The optimized docs taxonomy for this repo is deliberately **small**:

- `docs/architecture/` — current-state truth (system, contract, components, runbook) + a reconciliations ledger in its README that records every time reality supersedes a spec.
- `docs/ops/` — operational runbooks (cron, deploy adjuncts).
- `docs/superpowers/{specs,plans,reports,handoffs}` — dated, append-only provenance, now indexed.

**Not added, on purpose:** ADR folders, diagram folders, per-feature doc folders. This repo's measured failure mode is dual-write drift (hand-maintained copies of code facts going stale). Decisions already live in `system-architecture.md` §6 + the reconciliations ledger; every additional canonical home is another surface that rots. The rule that keeps this optimal: **facts live in code; docs either point at code or carry a dated banner; anything hand-copied from code must name its source of truth.**

## AGENTS.md analysis (asked: useful or not?)

**Verdict: useful — keep it, but it was actively harmful until fixed.** AGENTS.md is the cross-tool convention read by GPT/Codex/Cursor-class agents (including the GPT run on the sibling branch); CLAUDE.md is Claude-Code-specific. This repo had both, but AGENTS.md carried the single worst hallucination trap in the audit ("Drizzle+Postgres"). Policy going forward: AGENTS.md is a ≤35-line compact mirror of CLAUDE.md (identity, canon, layering, commands, donor warning); any edit to CLAUDE.md's facts must touch AGENTS.md in the same commit. Two files, one truth.

## Claude Code configuration: what was optimized

1. `CLAUDE.md` — added the missing Commands block (the canonical `npm run check` gate, dev/test/e2e, and the `db:migrate` inline-`DATABASE_URL` gotcha that previously cost silent dev-DB drift) and pointers to the `/box` and `/verify` skills and the specs index.
2. `.claude/settings.json` (new) — allowlist for `npm run check`/`test`/`typecheck`/`contract:check`, `git status/diff/log`, and `Read(docs/**, src/**)`: fewer permission prompts on every future session.
3. `.claude/skills/verify/SKILL.md` — boot recipe migrated psql→sqlite3; a runtime-verification skill that pointed at a nonexistent database was worse than none.
4. Deliberately NOT added: project-level hooks (operator already runs global hooks; stacking project hooks adds prompt noise) and speculative agents/commands dirs.

## Defects found in code (reported, not fixed — out of reorg scope)

1. **SSE contract gap:** `src/app/api/tailor/correlate/[id]/route.ts` hand-builds its SSE `done` event carrying a `CorrelationReport`, bypassing `SseEvent.parse`; the `SseEvent` `done` union in `src/types/index.ts` only allows `SearchRun | TailoredResume`. Either widen the union or route the emission through the schema.
2. **Stale seed claim was masking nothing** — but note `runbook.md`'s history of unreviewed edits suggests adding runbook spot-checks to any future doc-review pass.

## Manual follow-ups for the operator

1. `.env.example` line 1 still has a stale "Postgres connection string / PGlite" comment — the global `Read(**/.env*)` deny (correctly) blocks agents from touching any `.env*` file, even the example. One-line manual edit, or add a narrow `Read(.env.example)` allow carve-out.
2. Decide merge: this branch vs the GPT branch. Diff surface here: docs + agent config only, zero code changes, `npm run typecheck` green.
3. Optional disk cleanup: the 4.3 GB `.claude/worktrees/`.

## Method caveats

Before/after runs used different fresh Sonnet sessions; tool-call counts have run-to-run variance (±2-3 calls), so treat −29% as directional. The after-run also misattributed the design spec's stale "13 primitives" list to CLAUDE.md (already fixed at that point) — itself a nice demonstration of why the dated-spec banner in the polish commit matters.
