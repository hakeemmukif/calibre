# Caliber — Contabo VPS Deploy Runbook

> ✅ **Locally validated 2026-07-16** on Colima (arm64): image builds, the full compose stack boots (postgres/app/caddy), migrate + seed run, the Chromium/PDF render works in-image, and register→session succeeds. The VPS is x86_64 and builds its own image (`--build`), so re-run the smoke there. Fixes from that validation are folded into the artifacts and the steps below.
>
> ⚠️ **Every `docker compose` command needs `--env-file .env.production`.** Compose interpolates `${POSTGRES_PASSWORD}` from the `--env-file` (or a `.env`), **not** from a service's `env_file:`. Without the flag the password resolves to a blank string and Postgres refuses to boot.

## Architecture constraints (do not violate)
- **Exactly ONE app process.** The in-memory SSE run-registry and the single url-check worker (started by `src/instrumentation.ts` `register()`) only work in one process. **No PM2 cluster, no compose `replicas`.** A second app instance silently breaks SSE streaming and the url-check queue.
- **Chromium in the image.** `src/lib/pdf.ts` renders résumé PDFs in-process via playwright-chromium, so the runtime image is the Playwright base (`mcr.microsoft.com/playwright`). Keep its tag matched to the `playwright` version in `package.json`.
- **SSE-clean proxy.** `Caddyfile` sets `flush_interval -1` (no buffering) and 300s read/write timeouts — a single `scoreMatch` can leave an SSE stream silent ~36s. Don't lower these.
- **Uploads root** = `CALIBER_UPLOADS_DIR` (`/var/lib/caliber/uploads`), a persistent volume/bind-mount. Résumé files are stored under per-user relative keys (Step 5), so a host move is a pure `rsync` with zero DB rewriting.

## First deploy
Run every command with `--env-file .env.production` (see the interpolation note above).

1. **Point DNS** for your domain at the VPS; edit `Caddyfile` (replace `caliber.example.com`).
2. **Secrets:** `cp .env.production.example .env.production` and fill it in (Postgres password, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, `CALIBER_DAILY_LLM_USD`). Keep `.env.production` off git.
3. **Build:** `docker compose --env-file .env.production build`.
4. **Migrate + seed BEFORE the app boots.** The app's instrumentation hook writes to `search_runs` on startup, so booting it against an unmigrated DB throws an unhandledRejection. Bring up Postgres alone, run the one-offs, *then* the app:
   ```
   docker compose --env-file .env.production up -d postgres          # wait for healthy
   docker compose --env-file .env.production run --rm app npm run db:migrate   # tables + user_id backfill 0009
   docker compose --env-file .env.production run --rm app npm run db:seed      # 14 sources + admin from ADMIN_EMAIL/PASSWORD
   ```
5. **Start the app + Caddy:** `docker compose --env-file .env.production up -d`. Caddy auto-provisions TLS.
6. **Migrate existing upload files** (only if importing legacy data — see below). Fresh install: skip.
7. **Smoke:** visit `https://<domain>` → redirected to `/login` → register/login → onboarding → feed. Confirm PDF export works (tailor a résumé → download) — this validates Chromium in the image.

## Validate the Chromium/PDF path (first deploy)
`src/lib/pdf.ts` is never exercised by `npm test` (mocked). Confirm the real render in the running image — via `tsx` (the module is TypeScript with `@/` aliases, so plain `node -e "require(...)"` can't load it):
```
docker compose --env-file .env.production exec -T app \
  npx tsx -e "import {htmlToPdf} from './src/lib/pdf'; htmlToPdf('<h1>ok</h1>').then(b=>{require('fs').writeFileSync('/tmp/t.pdf',b);console.log('PDF OK, bytes:',b.length)})"
```
Locally this prints `PDF OK, bytes: 5448`.

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

## Image runtime: `next start` (not standalone)
The Dockerfile runs `next start` and keeps full `node_modules` — deliberate, because the tsx/drizzle-kit one-offs (`db:migrate`, `db:seed`, `migrate-uploads`) run via `docker compose run app ...` and need those binaries. `output: "standalone"` was **removed** from `next.config.mjs` (2026-07-16): it conflicts with `next start` (Next 15.5 warns "does not work") and the runtime image isn't the slim standalone bundle anyway. If you ever want the slimmer standalone image, you'd also need a separate migration path for the one-offs (standalone bundles only traced deps — no tsx/drizzle-kit).

## Pre-public tripwires (locked-decision behaviors — address before public exposure)
- **Open registration, no email verification** → every account spends real OpenRouter money. Add an invite/allowlist gate before the box is reachable by strangers.
- **No session expiry** → a leaked token is valid until logout. Add a TTL/sliding expiry.
- **Global daily cost cap** → one heavy user pauses everyone's queue. Make it per-user before a paying stranger.
- **url_checks worker surface** was scoped for tenancy here; expect a `drizzle` migration-journal conflict when `feat/parallel-scoring` eventually merges.
