# Caliber — Contabo VPS Deploy Runbook

> 🗄️ **DB = embedded SQLite (libsql), no database service.** `DATABASE_URL=file:/var/lib/caliber/data/caliber.db` on the `dbdata` named volume. There is no Postgres container. See [`docs/superpowers/specs/2026-07-16-sqlite-migration-design.md`].
>
> ✅ **SQLite stack locally validated 2026-07-16** on Colima (arm64) against these exact artifacts: build → migrate → seed → clean boot → login 200 / register 201 → Chromium PDF render → `.db`+`-wal`+`-shm` on the `dbdata` volume, with data surviving both `docker compose restart app` and a full `down`+`up`. The VPS is x86_64 and builds its own image (`--build`), so re-run the smoke there on first deploy.

## Architecture constraints (do not violate)
- **Exactly ONE app process.** The in-memory SSE run-registry and the single url-check worker (started by `src/instrumentation.ts` `register()`) only work in one process. **No PM2 cluster, no compose `replicas`.** A second app instance silently breaks SSE streaming and the url-check queue.
- **Chromium in the image.** `src/lib/pdf.ts` renders résumé PDFs in-process via playwright-chromium, so the runtime image is the Playwright base (`mcr.microsoft.com/playwright`). Keep its tag matched to the `playwright` version in `package.json`.
- **SSE-clean proxy.** `Caddyfile` sets `flush_interval -1` (no buffering) and 300s read/write timeouts — a single `scoreMatch` can leave an SSE stream silent ~36s. Don't lower these.
- **Uploads root** = `CALIBER_UPLOADS_DIR` (`/var/lib/caliber/uploads`), a persistent volume/bind-mount. Résumé files are stored under per-user relative keys (Step 5), so a host move is a pure `rsync` with zero DB rewriting.
- **Archive root** = `CALIBER_ARCHIVE_DIR` (`/var/lib/caliber/archive`), a persistent volume holding the nightly raw-crawl archive (see `docs/superpowers/specs/2026-07-21-raw-crawl-archive-design.md`). Unset in dev/tests — archiving disables cleanly with one log line (`archive disabled: CALIBER_ARCHIVE_DIR unset`), never a fabricated default path.

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

**Nightly off-box snapshot (the floor, scripted).** `scripts/backup.sh` (repo-tracked,
runs at `/opt/caliber/scripts/backup.sh`) does the whole pipeline: `VACUUM INTO`
(rm-first — VACUUM INTO refuses to overwrite) → tar the uploads volume →
`age -r <pubkey>` encrypt → `rclone` to R2, then writes the
`/root/.local/state/caliber/backup-last-success` marker that the alerting
check watches (>26h stale pages the operator). Cron on the host:

```
17 3 * * * /opt/caliber/scripts/backup.sh >> /var/log/caliber-backup.log 2>&1
```

Config in `/root/.config/caliber-backup.env` (NOT in git, NOT `.env.production`):
`AGE_RECIPIENT` (age public key) + `RCLONE_REMOTE` (R2 remote:bucket; creds in
rclone config). The age **private key lives in two places only**: the operator's
Mac and the password manager. `.env.production` is NOT automated — copy it to
the password manager manually whenever it changes.

**Restore drill (once, before invites, on the Mac):** `rclone copy` the latest
pair down → `age -d` both → boot an isolated stack
`docker compose -p caliber-restore-drill up` (distinct volumes — cannot touch
prod or dev) with the decrypted `caliber.db` + uploads dir mounted → log in,
open a real résumé → `docker compose -p caliber-restore-drill down -v`.

**Continuous (recommended for real users):** run [litestream](https://litestream.io) as a sidecar replicating `caliber.db` to S3/B2 for point-in-time restore — the standard SQLite production backup. Wire it when you take on paying users.

## Alerting

Two legs, both landing in the operator's Telegram (Decision 1 — same channel
as crash-page/feedback support):

1. **External (launch-gate leg 4, operator setup):** UptimeRobot polls
   `https://caliber.fightbase.co/api/health` — the only check that sees
   DNS/TLS/host-Caddy from outside — and pushes via the Telegram bot.
2. **On-box (first-week):** `scripts/alert-check.sh` on cron:
   ```
   */10 * * * * /opt/caliber/scripts/alert-check.sh >> /var/log/caliber-alert.log 2>&1
   ```
   Checks: on-box `/api/health`, disk ≥90%, stale backup (>26h without
   `scripts/backup.sh`'s success marker), and a tiered log classifier —
   **page-on-first** (crashes, the daily cost-cap trip, url-check worker-loop
   errors) vs **page-above-threshold** (connector/scoring/url-check flakes,
   `[client-error]` beacons; ≥5 per 10-min window). The designed url-check
   tier-escalation fallback never pages (allowlist matching). Payloads are
   summary counts only — raw log lines never leave the box.

Bot token + chat id live in `/root/.config/caliber-alert.env` (box-only, not
in git, not in `.env.production`).

## Image runtime: `next start` (not standalone)
The Dockerfile runs `next start` and keeps full `node_modules` — deliberate, because the tsx/drizzle-kit one-offs (`db:migrate`, `db:seed`, `migrate-uploads`) run via `docker compose run app ...` and need those binaries. `output: "standalone"` was **removed** from `next.config.mjs` (2026-07-16): it conflicts with `next start` (Next 15.5 warns "does not work") and the runtime image isn't the slim standalone bundle anyway. If you ever want the slimmer standalone image, you'd also need a separate migration path for the one-offs (standalone bundles only traced deps — no tsx/drizzle-kit).

## Pre-public tripwires (closed — membership-credits spec)
- **Invite-gated registration** — `POST /api/auth/register` requires `inviteCode` to match env `CALIBER_INVITE_CODE` (membership spec §4.5.2); the route fails loud if the env var is unset. Rotate the value to invalidate outstanding invites. A per-IP registration limit (`src/server/auth/registerLimit.ts`) also caps signups from one address.
- **30-day sliding session TTL** — idle sessions expire and are deleted; a leaked token stops working after 30 days of inactivity, not just at logout.
- **Per-user spend is bounded by prepaid credits** — every account starts with a 30-credit signup bundle and every scan/tailor/evaluate/extract/answer debits its own wallet (`src/server/credits`); a drained wallet 402s instead of spending more. `CALIBER_DAILY_LLM_USD=5` is no longer a per-user fairness knob — reframe it as the operator's **global wallet circuit-breaker**: a blanket kill-switch against a runaway bug burning OpenRouter spend, not a per-user cap.
- **url_checks worker surface** was scoped for tenancy here; expect a `drizzle` migration-journal conflict when `feat/parallel-scoring` eventually merges.

**Operator note:** set the real `CALIBER_INVITE_CODE` value in `/opt/caliber/.env.production` on the box before the next deploy — the app fails loud on boot in production if it's unset.
