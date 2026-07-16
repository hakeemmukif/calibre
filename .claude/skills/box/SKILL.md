---
name: box
description: Use when you need to run commands on, inspect, or deploy to the Caliber production VPS (caliber.fightbase.co / 13.140.169.239) over SSH.
---

# The Box — Caliber production VPS

## Connect
```bash
ssh root@13.140.169.239                                        # key-based from this Mac, no password
ssh -o BatchMode=yes -o ConnectTimeout=10 root@13.140.169.239 '<cmd>'   # non-interactive — ALWAYS use this form in tool calls
```

## Host facts (verified 2026-07-16)
- Contabo `vmi3365285`, Ubuntu 24.04, x86_64; docker + git preinstalled.
- DNS: `caliber.fightbase.co` → 13.140.169.239 (Cloudflare zone `fightbase.co`, **DNS-only/grey-cloud — keep it grey**: the orange-cloud proxy buffers responses and silently kills the app's SSE streams).

## ⚠️ SHARED BOX — the one rule
A Caddy **already owns ports 80/443** on this host (it serves `timeline.fightbase.co`). Therefore:
- **NEVER start the compose `caddy` service** and never bind 80/443 from Docker — `docker compose up -d app` (app only), not a bare `up -d`.
- Caliber is reachable via a site block in the **host** Caddy → `127.0.0.1:3000` (SSE flags: `flush_interval -1`, long read/write timeouts).
- Before any host-Caddy reload: `caddy validate --config /etc/caddy/Caddyfile` — a broken reload takes timeline down with it.

## Deploy new code (push-to-deploy — the box CANNOT reach GitHub, repo is private)
```bash
# from the Mac checkout:
git push ssh://root@13.140.169.239/opt/caliber main:main
ssh root@13.140.169.239 'cd /opt/caliber && git reset --hard main && docker compose build && docker compose run --rm app npm run db:migrate && docker compose up -d app'
```

## Operate
```bash
cd /opt/caliber                                   # the git checkout
docker compose run --rm app npm run db:migrate    # BEFORE first app boot (instrumentation writes on startup)
docker compose up -d app                          # app only — see the one rule above
docker compose logs app --tail 50
```
- Secrets: `/opt/caliber/.env.production` (never in git; admin creds live there).
- Box-local `docker-compose.override.yml` publishes app on 127.0.0.1:3000 and profile-disables compose caddy — do not delete it.
- Nightly backup: `/etc/cron.daily/caliber-backup` (VACUUM INTO snapshot → /backups, 14-day rotation).
- Full runbook: `DEPLOY.md` in the checkout.
