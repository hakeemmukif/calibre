# Caliber — Contabo VPS Deploy Runbook

> ⚠️ **Not executed during the multi-tenant migration** (no Docker/VPS in that environment). These artifacts (`Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.production.example`) are written and internally consistent but **must be validated by an actual deploy**. Steps below are the operator's to run.

## Architecture constraints (do not violate)
- **Exactly ONE app process.** The in-memory SSE run-registry and the single url-check worker (started by `src/instrumentation.ts` `register()`) only work in one process. **No PM2 cluster, no compose `replicas`.** A second app instance silently breaks SSE streaming and the url-check queue.
- **Chromium in the image.** `src/lib/pdf.ts` renders résumé PDFs in-process via playwright-chromium, so the runtime image is the Playwright base (`mcr.microsoft.com/playwright`). Keep its tag matched to the `playwright` version in `package.json`.
- **SSE-clean proxy.** `Caddyfile` sets `flush_interval -1` (no buffering) and 300s read/write timeouts — a single `scoreMatch` can leave an SSE stream silent ~36s. Don't lower these.
- **Uploads root** = `CALIBER_UPLOADS_DIR` (`/var/lib/caliber/uploads`), a persistent volume/bind-mount. Résumé files are stored under per-user relative keys (Step 5), so a host move is a pure `rsync` with zero DB rewriting.

## First deploy
1. **Point DNS** for your domain at the VPS; edit `Caddyfile` (replace `caliber.example.com`).
2. **Secrets:** `cp .env.production.example .env.production` and fill it in (Postgres password, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, `CALIBER_DAILY_LLM_USD`). Keep `.env.production` off git.
3. **Build + start:** `docker compose up -d --build`. Caddy auto-provisions TLS.
4. **Migrate the DB** (creates all tables incl. `users`/`sessions` and runs the user_id backfill 0009):
   `docker compose exec app npm run db:migrate`
5. **Seed** the sources + the admin (from `ADMIN_EMAIL`/`ADMIN_PASSWORD`):
   `docker compose exec app npm run db:seed`
6. **Migrate existing upload files** (only if importing legacy data — see below). Fresh install: skip.
7. **Smoke:** visit `https://<domain>` → redirected to `/login` → register/login → onboarding → feed. Confirm PDF export works (tailor a résumé → download) — this validates Chromium in the image.

## Validate the Chromium/PDF path (first deploy)
`src/lib/pdf.ts` is never exercised by `npm test` (mocked). Confirm the real render on the image:
```
docker compose exec app node -e "require('./src/lib/pdf').htmlToPdf('<h1>ok</h1>').then(b=>require('fs').writeFileSync('/tmp/t.pdf',b))"
docker compose exec app ls -la /tmp/t.pdf   # should be a valid one-page PDF
```

## Data move (local dev DB → VPS)
Because upload keys are relative and the DB holds no absolute paths:
1. `pg_dump` the local `caliber` DB → restore into the VPS Postgres (`docker compose exec -T postgres pg_restore ...` or `psql < dump.sql`).
2. `rsync` the local uploads dir → the VPS `uploads` volume mount.
3. If the local rows still hold **absolute** `originalPath` values (pre-Step-5), run the one-time migration on the VPS after restore:
   `docker compose exec app npx tsx src/server/resume/migrate-uploads.ts` (idempotent; rewrites absolute paths → per-user relative keys).

## Nightly backup (ops floor before a second user)
Cron on the host:
```
# pg dump
docker compose exec -T postgres pg_dump -U caliber caliber | gzip > /backups/caliber-$(date +%F).sql.gz
# uploads
rsync -a /var/lib/docker/volumes/<project>_uploads/_data/ /backups/uploads/
```
Copy `/backups` off-box.

## Standalone image (optional, slimmer — validate first)
`next.config.mjs` sets `output: "standalone"`. The Dockerfile currently runs `next start` (robust). To slim the image, switch the runtime `CMD` to `node .next/standalone/server.js` and copy `.next/standalone` + `.next/static` + `public` instead of full `node_modules` — **but first confirm `.next/standalone/server.js` exists after `npm run build` on the build host** (it was incomplete in the migration dev worktree; a clean build usually fixes it). If missing, keep `next start`.

## Pre-public tripwires (locked-decision behaviors — address before public exposure)
- **Open registration, no email verification** → every account spends real OpenRouter money. Add an invite/allowlist gate before the box is reachable by strangers.
- **No session expiry** → a leaked token is valid until logout. Add a TTL/sliding expiry.
- **Global daily cost cap** → one heavy user pauses everyone's queue. Make it per-user before a paying stranger.
- **url_checks worker surface** was scoped for tenancy here; expect a `drizzle` migration-journal conflict when `feat/parallel-scoring` eventually merges.
