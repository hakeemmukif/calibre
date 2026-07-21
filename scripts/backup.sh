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
LOCAL_RETENTION_DIR="${CALIBER_BACKUP_LOCAL_DIR:-/root/backups/local}"

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

# 2. Local on-disk retention (unencrypted, plain DB — fast restores without
#    the age private key). Separate directory from the legacy
#    /etc/cron.daily/caliber-backup 14-day rotation so the two never collide.
mkdir -p "$LOCAL_RETENTION_DIR"
cp "$WORK/caliber-$STAMP.db" "$LOCAL_RETENTION_DIR/caliber-$STAMP.db"
find "$LOCAL_RETENTION_DIR" -type f -name "caliber-*.db" -mtime +30 -delete

# 3. Uploads (the volume is already in the nightly cron per the consolidation
#    doc — this adds the off-box + encrypted leg).
docker compose cp app:/var/lib/caliber/uploads "$WORK/uploads"
tar -czf "$WORK/uploads-$STAMP.tar.gz" -C "$WORK" uploads

# 3b. Raw crawl archive (2026-07-21-raw-crawl-archive-design.md §6) — the
# newest date-dir under the archive volume (at this 03:17 run, that's the
# previous evening's 21:00-Berlin crawl). Contents are already gzipped, so
# `tar -cf` with NO `-z`. Archiving may be disabled (CALIBER_ARCHIVE_DIR
# unset) or the crawl may not have produced a night's dir yet — either way,
# log and skip; alert-check already pages on crawl failure itself, this is
# not a second failure surface. Local date-dirs are never pruned here
# (retention decision A) — the box itself is the copy of record, this is a
# nightly off-box mirror.
ARCHIVE_DATE_DIR="$(docker compose exec -T app sh -c 'ls -1 /var/lib/caliber/archive 2>/dev/null | sort | tail -1' | tr -d '\r')"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  docker compose cp "app:/var/lib/caliber/archive/$ARCHIVE_DATE_DIR" "$WORK/archive-$ARCHIVE_DATE_DIR"
  tar -cf "$WORK/archive-$ARCHIVE_DATE_DIR.tar" -C "$WORK" "archive-$ARCHIVE_DATE_DIR"
else
  echo "backup: no archive date-dir found — skipping (archiving disabled or crawl produced none yet)"
fi

# 4. Encrypt to the operator's age public key.
age -r "$AGE_RECIPIENT" -o "$WORK/caliber-$STAMP.db.age" "$WORK/caliber-$STAMP.db"
age -r "$AGE_RECIPIENT" -o "$WORK/uploads-$STAMP.tar.gz.age" "$WORK/uploads-$STAMP.tar.gz"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  age -r "$AGE_RECIPIENT" -o "$WORK/archive-$ARCHIVE_DATE_DIR.tar.age" "$WORK/archive-$ARCHIVE_DATE_DIR.tar"
fi

# 5. Off-box.
rclone copyto "$WORK/caliber-$STAMP.db.age" "$RCLONE_REMOTE/db/caliber-$STAMP.db.age"
rclone copyto "$WORK/uploads-$STAMP.tar.gz.age" "$RCLONE_REMOTE/uploads/uploads-$STAMP.tar.gz.age"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  rclone copyto "$WORK/archive-$ARCHIVE_DATE_DIR.tar.age" "$RCLONE_REMOTE/archive/archive-$ARCHIVE_DATE_DIR.tar.age"
fi

# 6. Success marker — alert-check.sh pages when this is older than ~26h.
mkdir -p "$STATE_DIR"
date +%s > "$STATE_DIR/backup-last-success"
echo "backup ok: caliber-$STAMP.db.age + uploads-$STAMP.tar.gz.age -> $RCLONE_REMOTE"
