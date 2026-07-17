#!/usr/bin/env bash
# Caliber nightly off-box backup (pre-launch hardening Task 2).
# Repo-tracked at scripts/backup.sh → deployed at /opt/caliber/scripts/backup.sh
# so push-to-deploy maintains it. Cron (operator runbook):
#   17 3 * * * /opt/caliber/scripts/backup.sh >> /var/log/caliber-backup.log 2>&1
#
# Pipeline: VACUUM INTO (consistent hot snapshot) → tar uploads → age-encrypt
# with the operator's PUBLIC key → rclone to R2. `.env.production` is NOT
# automated (manual copy to the password manager). The age PRIVATE key never
# touches this box — it lives on the Mac + the password manager.
#
# Config: /root/.config/caliber-backup.env (box-only, never in git):
#   AGE_RECIPIENT=age1...            # age public key
#   RCLONE_REMOTE=r2:caliber-backups # rclone remote:bucket (creds live in rclone config)
#
# The CALIBER_BACKUP_* overrides exist ONLY as test seams (stub-bin dry-run);
# production runs use the defaults.
set -euo pipefail

CONF="${CALIBER_BACKUP_CONF:-/root/.config/caliber-backup.env}"
STATE_DIR="${CALIBER_BACKUP_STATE_DIR:-/root/.local/state/caliber}"
COMPOSE_DIR="${CALIBER_COMPOSE_DIR:-/opt/caliber}"

[ -f "$CONF" ] || { echo "backup: missing config $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${AGE_RECIPIENT:?backup: AGE_RECIPIENT not set in $CONF}"
: "${RCLONE_REMOTE:?backup: RCLONE_REMOTE not set in $CONF}"

cd "$COMPOSE_DIR"
STAMP="$(date +%F)"
WORK="$(mktemp -d /tmp/caliber-backup.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# 1. Consistent DB snapshot. VACUUM INTO refuses to overwrite → rm first
#    (DEPLOY.md idiom: the job fails silently from night two otherwise).
docker compose exec -T app rm -f /var/lib/caliber/data/snapshot.db
docker compose exec -T app npx tsx -e "const{createClient}=require('@libsql/client');const c=createClient({url:process.env.DATABASE_URL});c.execute(\"VACUUM INTO '/var/lib/caliber/data/snapshot.db'\").then(()=>console.log('vacuum ok'))"
docker compose cp app:/var/lib/caliber/data/snapshot.db "$WORK/caliber-$STAMP.db"

# 2. Uploads (the volume is already in the nightly cron per the consolidation
#    doc — this adds the off-box + encrypted leg).
docker compose cp app:/var/lib/caliber/uploads "$WORK/uploads"
tar -czf "$WORK/uploads-$STAMP.tar.gz" -C "$WORK" uploads

# 3. Encrypt to the operator's age public key.
age -r "$AGE_RECIPIENT" -o "$WORK/caliber-$STAMP.db.age" "$WORK/caliber-$STAMP.db"
age -r "$AGE_RECIPIENT" -o "$WORK/uploads-$STAMP.tar.gz.age" "$WORK/uploads-$STAMP.tar.gz"

# 4. Off-box.
rclone copyto "$WORK/caliber-$STAMP.db.age" "$RCLONE_REMOTE/db/caliber-$STAMP.db.age"
rclone copyto "$WORK/uploads-$STAMP.tar.gz.age" "$RCLONE_REMOTE/uploads/uploads-$STAMP.tar.gz.age"

# 5. Success marker — alert-check.sh pages when this is older than ~26h.
mkdir -p "$STATE_DIR"
date +%s > "$STATE_DIR/backup-last-success"
echo "backup ok: caliber-$STAMP.db.age + uploads-$STAMP.tar.gz.age -> $RCLONE_REMOTE"
