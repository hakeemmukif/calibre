# Caliber

Standalone AI job-search + application-tracking web app (Next.js 15 App Router,
React 19, TypeScript). Code-led, single-operator MVP, built by re-aiming and
extracting logic from a donor repo.

**Niche:** Malaysian/SEA professionals seeking remote/global roles + Malaysia-local
roles, launched together. **Wedge:** fit + **legitimacy** (ghost/scam detection)
foregrounded — no incumbent tracker leads with it.

See `CLAUDE.md` for the full product/architecture canon before making changes.

## Quickstart

```bash
cp .env.example .env   # fill in DATABASE_URL, OPENROUTER_API_KEY, etc.
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Then open `http://localhost:3000`.

The DB is a local SQLite file via libsql (`DATABASE_URL=file:./caliber.db`) —
no database server to install or run. `npm run db:seed` creates the
bootstrap admin account (`ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env`) and the
seed source rows.

## Commands

| Purpose | Commands |
|---|---|
| Dev loop | `npm run dev`, `npm test`, `npm run typecheck`, `npm run storybook` |
| **Canonical gate** | `npm run check` — typecheck + vitest + `contract:check` + build. Run this before calling anything done. |
| Database | `npm run db:migrate`, `npm run db:generate`, `npm run db:seed` |
| E2E | `npm run test:e2e` (Playwright) |
| Contract | `npm run contract` (generate `contract/openapi.json`), `npm run contract:check` (regenerate + diff --exit-code) |
| **Cron/ops — run on the production box, not locally** | `npm run crawl:once`, `npm run sources:engine`, `npm run sources:growth`, `npm run sources:freshness` |
| Eval harnesses — hit real LLM/network, cost tokens | `npm run eval:resume`, `npm run eval:tailor`, `npm run smoke:real` |

## Architecture

Layering is one-way: UI (`src/caliber-ui`) → `src/features/*` (client-side
service logic) → `src/server/*` — the only layer that touches the DB or an
LLM. The contract is Zod schemas in `src/types`, generated into
`contract/openapi.json`; nothing else defines entity shapes. A nightly crawl
fills a shared `postings` pool; user scans read that pool and score against
it — there is no per-scan connector fan-out. Storybook (`npm run storybook`)
is the canonical component/page gallery, not Figma.

## Doc map

- `CLAUDE.md` / `AGENTS.md` — agent instructions, canon, working rules.
- `docs/architecture/README.md` — architecture index (data model, services, flows, contract).
- `docs/superpowers/README.md` — dated specs/plans index.
- `DEPLOY.md` — production deploy runbook (VPS, Docker Compose, Caddy).
- `e2e/README.md` — Playwright e2e setup and conventions.

## Production

Caliber runs as a Docker Compose stack on a Contabo VPS behind Caddy at
`caliber.fightbase.co`. Hard rule: exactly **one** app process — the
in-memory SSE run-registry and the single url-check worker only work in a
single process, so no PM2 cluster and no compose `replicas`. See `DEPLOY.md`
for the full runbook.
