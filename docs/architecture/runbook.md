# Runbook — running the real app (F1–F6)

For the quick path (`npm install && npm run dev`) and the `npm test` /
`npm run check` gate, see the root `README.md` first.

Verified prerequisites to boot `next dev`/`next start` against the real backend (not the spine test's mocked LLM/connectors). See `task-B10-report.md` §9 for how these were confirmed.

1. Create `.env` with:
   - `DATABASE_URL` — a SQLite `file:` URL (libsql), e.g. `file:./caliber.db` (see `2026-07-16-sqlite-migration-design.md`). Required just for the process to boot: `src/instrumentation.ts` calls `markStaleRunningOnBoot()` on startup, which calls `getDb()` (`src/server/persistence/db.ts`) — this throws `"DATABASE_URL is not set"` before **any** route, including `/api/health`, can serve a request.
   - `OPENROUTER_API_KEY` — required the first time any route calls an LLM task (resume-extract, jd-extract, match-score, question-extract, question-answer, tailor; `src/lib/llm/client.ts`).
2. Run `npm run db:migrate && npm run db:seed`. The seed rows (`src/server/persistence/seed.ts`) ship with real ATS org slugs / board queries (`greenhouse`/`lever`/`ashby`/`smartrecruiters` companies plus the `jobstreet` board) — a real search can discover against them immediately.
3. Run `npx playwright install chromium` — required for `GET /api/tailor/:id/pdf` (`src/lib/pdf.ts`) and the liveness deep-probe fallback (`CALIBER_LIVENESS_PLAYWRIGHT=1`, `src/server/score/liveness.ts`) and the F4 tier-2 DOM parse; none of these launch Chromium without it.
4. `npm run dev`.

## Eval harnesses (live LLM, costs real tokens)

- `OPENROUTER_API_KEY=… npm run eval:resume` — résumé-extraction regression. Growth rule: every résumé that fails in prod joins `src/server/resume/__fixtures__/golden/`.
- `OPENROUTER_API_KEY=… npm run eval:tailor` — requirement-correlation regression (costs real tokens). Growth rule: every misclassified résumé/JD joins `src/server/tailor/__fixtures__/golden/`.
