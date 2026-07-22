---
name: verify
description: Drive the Caliber app end-to-end to observe a change working at runtime (not tests). Boot recipe, LLM test-doubles, and the paste/queue/worker flows worth driving.
---

# Verifying Caliber at runtime

Caliber is a Next.js 15 app; the deploy target is long-lived Node (`next start`).
Verification = boot it, drive the real surface (HTTP + DB, and/or a browser),
observe. Don't run `vitest`/`tsc` here — that's CI.

## Boot recipe (isolated, no real LLM spend)

The app has a built-in **test-doubles** mode (`CALIBER_TEST_DOUBLES=1`) that
scripts the LLM + network leaf calls — the real worker/DB/HTTP/UI still run.
Use it unless you specifically need real scoring output (real needs
`OPENROUTER_API_KEY`, which lives in `.env`, not `.env.local`).

```bash
# 1. isolated scratch DB (never touch the operator's dev DB) — a plain SQLite file, no server
rm -f /tmp/caliber_verify.db*
DATABASE_URL="file:/tmp/caliber_verify.db" npm run db:migrate
DATABASE_URL="file:/tmp/caliber_verify.db" npm run db:seed:test   # seeds sources (incl. `manual`) + a `default` profile, NO résumé

# 2. boot the built app against it (run in background). instrumentation.ts starts the url-check worker on boot.
DATABASE_URL="file:/tmp/caliber_verify.db" CALIBER_TEST_DOUBLES=1 npx next start -p 3123   # needs a prior `next build`

# 3. the pipeline requires an ACTIVE résumé — create one (extraction runs via the double):
curl -s -X POST localhost:3123/api/resume -H 'content-type: application/json' -d '{"text":"...(>=100 chars)..."}'
```

`db:migrate` reads `.env.local` (usually absent locally), not `.env` — pass
`DATABASE_URL` inline as above or it will silently target the wrong DB.
No `psql`: if a flow needs to inspect the DB directly, use `sqlite3
/tmp/caliber_verify.db` instead.

Health check: `curl -s -o /dev/null -w '%{http_code}' localhost:3123/api/jobs?persona=pasted` → 200.

## Flows worth driving (url-check queue / parallel scoring)

- **Backgrounding + worker execution:** `POST /api/jobs/check {url,text}` → `202` `queued`, then the worker runs it → `completed` with a `jobId`. Poll `GET /api/jobs/check/:id`. Paste-mode (`url`+`text`) skips scraping, so it's deterministic under doubles.
- **Concurrency cap (=3):** POST ~8 jobs at once, then tight-loop `sqlite3 /tmp/caliber_verify.db "select count(*) from url_checks where status='running'"` and record the peak — must be ≤3.
- **Restart recovery (headline):** directly insert orphaned `running` rows (`attempts=1` resumable, `attempts=2` dead) into `url_checks` with a valid `raw:{text:...}`, then kill + restart the process. Boot recovery (`requeueOrphanedRunning`) requeues `attempts<2` → worker resumes → `completed`; `attempts>=2` → `failed` with "stale: process restarted after the retry budget was exhausted".
- **UI (Playwright):** run the script from the repo root with `NODE_PATH="$PWD/node_modules"` (script can live in scratchpad). Bar selectors: `getByLabel('Job posting URL')` + `getByRole('button',{name:'Check'})`. The `ScoringStatusCard` renders on `/feed`; the `CheckDock` corner tray shows on OTHER routes — but only after **client-side** nav (click a sidebar item, e.g. `getByText('Applied')`), NOT `page.goto` (a hard reload wipes the in-memory `checksStore` singleton; `?active=1` reload-hydration is deferred).

## Gotchas

- `next start` reads `.env` + `.env.local`; an exported `DATABASE_URL` overrides them (process.env wins). `OPENROUTER_API_KEY` is in `.env`.
- Test doubles complete in ~1s, so catch transient states with a tight sampling loop, not a single query.
- Cleanup: `pkill -f "next start -p 3123"`; `rm -f /tmp/caliber_verify.db*`.
