# Caliber — Contabo VPS Deploy Runbook

> 🗄️ **DB = embedded SQLite (libsql), no database service.** `DATABASE_URL=file:/var/lib/caliber/data/caliber.db` on the `dbdata` named volume. There is no Postgres container. See [`docs/superpowers/specs/2026-07-16-sqlite-migration-design.md`].
>
> ✅ **SQLite stack locally validated 2026-07-16** on Colima (arm64) against these exact artifacts: build → migrate → seed → clean boot → login 200 / register 201 → Chromium PDF render → `.db`+`-wal`+`-shm` on the `dbdata` volume, with data surviving both `docker compose restart app` and a full `down`+`up`. The VPS is x86_64 and builds its own image (`--build`), so re-run the smoke there on first deploy.

## Architecture constraints (do not violate)
- **Exactly ONE app process.** The in-memory SSE run-registry and the single url-check worker (started by `src/instrumentation.ts` `register()`) only work in one process. **No PM2 cluster, no compose `replicas`.** A second app instance silently breaks SSE streaming and the url-check queue.
- **Chromium in the image.** `src/lib/pdf.ts` renders résumé PDFs in-process via playwright-chromium, so the runtime image is the Playwright base (`mcr.microsoft.com/playwright`). Keep its tag matched to the `playwright` version in `package.json`.
- **SSE-clean proxy.** `Caddyfile` sets `flush_interval -1` (no buffering) and 300s read/write timeouts — a single `scoreMatch` can leave an SSE stream silent ~36s. Don't lower these.
- **Uploads root** = `CALIBER_UPLOADS_DIR` (`/var/lib/caliber/uploads`), a persistent volume/bind-mount. Résumé files are stored under per-user relative keys (Step 5), so a host move is a pure `rsync` with zero DB rewriting.

## First deploy
App secrets load from the app service's `env_file: [.env.production]`. There is no
`${...}` compose interpolation any more (Postgres is gone), so a plain `docker compose`
without `--env-file` is fine — the flag is only needed if you add interpolated vars.

1. **Point DNS** for your domain at the VPS; edit `Caddyfile` (replace `caliber.example.com`).
2. **Secrets:** `cp .env.production.example .env.production` and fill it in (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, `CALIBER_DAILY_LLM_USD`). No DB password — the DB is a local file. Keep `.env.production` off git.
3. **Build:** `docker compose build`.
4. **Migrate + seed BEFORE the app boots.** The app's instrumentation hook writes to `search_runs` on startup, so booting it against an unmigrated DB throws an unhandledRejection. Run the one-offs first — they hit the same `caliber.db` on the `dbdata` volume, created on first migrate:
   ```
   docker compose run --rm app npm run db:migrate   # applies drizzle/0000 baseline to caliber.db on the volume
   docker compose run --rm app npm run db:seed      # 14 sources + admin from ADMIN_EMAIL/PASSWORD
   ```
   (No database service to wait for; `run --rm app` mounts the same `dbdata` volume as the long-running app, so the file it creates is the one the app then opens.)
5. **Start the app + Caddy:** `docker compose up -d`. Caddy auto-provisions TLS.
6. **Migrate existing upload files** (only if importing legacy data — see below). Fresh install: skip.
7. **Smoke:** visit `https://<domain>` → redirected to `/login` → register/login → onboarding → feed. Confirm PDF export works (tailor a résumé → download) — this validates Chromium in the image.

## Validate the Chromium/PDF path (first deploy)
`src/lib/pdf.ts` is never exercised by `npm test` (mocked). Confirm the real render in the running image — via `tsx` (the module is TypeScript with `@/` aliases, so plain `node -e "require(...)"` can't load it):
```
docker compose --env-file .env.production exec -T app \
  npx tsx -e "import {htmlToPdf} from './src/lib/pdf'; htmlToPdf('<h1>ok</h1>').then(b=>{require('fs').writeFileSync('/tmp/t.pdf',b);console.log('PDF OK, bytes:',b.length)})"
```
Locally this prints `PDF OK, bytes: 5448`.

## Data move (local dev DB → VPS) — only if importing; a fresh install skips this
The DB is a single SQLite file and upload keys are relative (no absolute paths in rows):
1. **Checkpoint** the local WAL so the `.db` file is self-contained, with the app stopped:
   `sqlite3 ./caliber.db 'PRAGMA wal_checkpoint(TRUNCATE);'` (or just stop the app cleanly first).
2. Copy the file onto the VPS `dbdata` volume **before** the app boots there (e.g. `docker compose cp ./caliber.db app:/var/lib/caliber/data/caliber.db` against a created-but-stopped `app`, or a one-off `docker run` that mounts the volume). Copy only the `.db` — not `-wal`/`-shm`.
3. `rsync` the local uploads dir → the VPS `uploads` volume mount.
4. If local rows still hold **absolute** `originalPath` values (pre-Step-5), run the one-time migration on the VPS after the copy:
   `docker compose run --rm app npx tsx src/server/resume/migrate-uploads.ts` (idempotent; rewrites absolute paths → per-user relative keys).

## Backup (ops floor before a second user)
SQLite is one file, but do **not** `cp` a live WAL DB — take a consistent snapshot.

**Nightly snapshot (floor).** `VACUUM INTO` is a safe hot copy while the app runs (single-writer). Cron on the host:
```
# VACUUM INTO refuses to overwrite an existing file — clear last night's snapshot
# FIRST or the job fails silently from night two (verified on the running stack:
# "SQLITE_ERROR: output file already exists"). rm-first is idempotent even after
# a partial run (e.g. died between vacuum and cp).
docker compose exec -T app rm -f /var/lib/caliber/data/snapshot.db
# consistent db snapshot written into the dbdata volume, then copied off
docker compose exec -T app npx tsx -e "const{createClient}=require('@libsql/client');const c=createClient({url:process.env.DATABASE_URL});c.execute(\"VACUUM INTO '/var/lib/caliber/data/snapshot.db'\").then(()=>console.log('ok'))"
cp   /var/lib/docker/volumes/<project>_dbdata/_data/snapshot.db /backups/caliber-$(date +%F).db
# uploads
rsync -a /var/lib/docker/volumes/<project>_uploads/_data/ /backups/uploads/
```
Copy `/backups` off-box.

**Continuous (recommended for real users):** run [litestream](https://litestream.io) as a sidecar replicating `caliber.db` to S3/B2 for point-in-time restore — the standard SQLite production backup. Wire it when you take on paying users.

## Image runtime: `next start` (not standalone)
The Dockerfile runs `next start` and keeps full `node_modules` — deliberate, because the tsx/drizzle-kit one-offs (`db:migrate`, `db:seed`, `migrate-uploads`) run via `docker compose run app ...` and need those binaries. `output: "standalone"` was **removed** from `next.config.mjs` (2026-07-16): it conflicts with `next start` (Next 15.5 warns "does not work") and the runtime image isn't the slim standalone bundle anyway. If you ever want the slimmer standalone image, you'd also need a separate migration path for the one-offs (standalone bundles only traced deps — no tsx/drizzle-kit).

## Pre-public tripwires (locked-decision behaviors — address before public exposure)
- **Open registration, no email verification** → every account spends real OpenRouter money. Add an invite/allowlist gate before the box is reachable by strangers.
- **No session expiry** → a leaked token is valid until logout. Add a TTL/sliding expiry.
- **Global daily cost cap** → one heavy user pauses everyone's queue. Make it per-user before a paying stranger.
- **url_checks worker surface** was scoped for tenancy here; expect a `drizzle` migration-journal conflict when `feat/parallel-scoring` eventually merges.
