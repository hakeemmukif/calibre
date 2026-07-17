#!/usr/bin/env bash
# Caliber tiered alert check (pre-launch hardening Task 3, first-week slice).
# Repo-tracked → /opt/caliber/scripts/alert-check.sh. Cron (operator runbook):
#   */10 * * * * /opt/caliber/scripts/alert-check.sh >> /var/log/caliber-alert.log 2>&1
#
# Transport: Telegram bot (Decision 1). Config /root/.config/caliber-alert.env
# (box-only, never in git, never in .env.production):
#   TELEGRAM_BOT_TOKEN=123:abc
#   TELEGRAM_CHAT_ID=123456789
#
# Classifier contract (consolidation doc Task 3):
# - PAGE-ON-FIRST: crash / cost-cap / worker-loop literals — one hit pages.
# - PAGE-ABOVE-THRESHOLD: routine connector/scoring/url-check flakes — pages
#   only at >= THRESHOLD total hits in the window.
# - The DESIGNED tier-escalation fallback at src/server/url-check/run.ts:203
#   ("tier-1 extract-gate threw, escalating to tier 2") matches NEITHER list —
#   allowlist matching means it can never page (the naive `grep -i error` trap).
# - COUNT-THEN-PUSH-ONCE: one summary message per run, pattern counts only —
#   NEVER raw log lines to a third-party service (Telegram included).
#
# CALIBER_ALERT_* overrides are test seams; production uses the defaults.
# Requires bash >= 4.4 (empty-array expansion under set -u).
set -euo pipefail

CONF="${CALIBER_ALERT_CONF:-/root/.config/caliber-alert.env}"
COMPOSE_DIR="${CALIBER_COMPOSE_DIR:-/opt/caliber}"
STATE_DIR="${CALIBER_ALERT_STATE_DIR:-/root/.local/state/caliber}"
WINDOW="${CALIBER_ALERT_WINDOW:-11m}"
THRESHOLD="${CALIBER_ALERT_THRESHOLD:-5}"
HEALTH_URL="${CALIBER_ALERT_HEALTH_URL:-http://localhost:3000/api/health}"

[ -f "$CONF" ] || { echo "alert-check: missing config $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${TELEGRAM_BOT_TOKEN:?alert-check: TELEGRAM_BOT_TOKEN not set in $CONF}"
: "${TELEGRAM_CHAT_ID:?alert-check: TELEGRAM_CHAT_ID not set in $CONF}"

alerts=()

# 1. On-box health (UptimeRobot covers DNS/TLS/host-Caddy from outside).
if ! curl -fsS --max-time 10 "$HEALTH_URL" > /dev/null 2>&1; then
  alerts+=("health: $HEALTH_URL failing on-box")
fi

# 2. Disk.
DISK_PCT="$(df -P / | awk 'NR==2 { sub(/%/, "", $5); print $5 }')"
if [ "$DISK_PCT" -ge 90 ]; then
  alerts+=("disk: root filesystem at ${DISK_PCT}%")
fi

# 3. Stale backup (>26h since scripts/backup.sh last wrote its marker).
# A corrupt/empty marker is treated as STALE rather than tripping a bash
# arithmetic error that would abort the run before health/disk findings push.
MARKER="$STATE_DIR/backup-last-success"
STALE=0
if [ ! -f "$MARKER" ]; then
  STALE=1
else
  ts="$(cat "$MARKER")"
  case "$ts" in
    ''|*[!0-9]*) STALE=1 ;;
    *)
      if [ "$(( $(date +%s) - ts ))" -gt $((26 * 3600)) ]; then
        STALE=1
      fi
      ;;
  esac
fi
if [ "$STALE" -eq 1 ]; then
  alerts+=("backup: no successful off-box snapshot in >26h")
fi

# 4. Log classifier over the cron window.
LOGS="$(cd "$COMPOSE_DIR" && docker compose logs app --since "$WINDOW" 2>&1 || true)"

# The unauthenticated POST /api/client-error beacon logs client-controlled
# message/stack/url verbatim as `[client-error]` lines. Classifying those
# lines' TEXT against the page-on-first / page-above-threshold literals would
# let an anonymous request spoof a page (e.g. message: "x crashed
# unexpectedly"). LOGS_NO_BEACON strips `[client-error]` lines before pattern
# matching; only the `\[client-error\]` marker itself (the legitimate
# beacon-volume signal) is still counted against the full, unfiltered $LOGS.
LOGS_NO_BEACON="$(printf '%s\n' "$LOGS" | grep -v '\[client-error\]' || true)"

PAGE_FIRST=(
  "crashed unexpectedly"
  "failed to persist 'failed'"
  "correlate run .* crashed:"
  "daily cost cap reached"
  "url-check worker: drain loop error"
  "url-check worker: drain slot crashed"
  "url-check admission: kick failed"
)

PAGE_THRESHOLD=(
  "connector \".*\" failed:"
  "scoring job .* failed:"
  "detail fetch for job .* failed:"
  "pipeline failed:"
  "processRow crashed for row"
  "url-check worker: sweep failed"
  "detail fetch failed:"
  "evaluate failed:"
  "failed to persist partial stats"
  "\[client-error\]"
)

first_hits=()
for pattern in "${PAGE_FIRST[@]}"; do
  n="$(printf '%s\n' "$LOGS_NO_BEACON" | grep -cE "$pattern" || true)"
  [ "$n" -gt 0 ] && first_hits+=("${pattern} x${n}")
done
if [ "${#first_hits[@]}" -gt 0 ]; then
  alerts+=("logs page-on-first: ${first_hits[*]}")
fi

threshold_total=0
threshold_summary=()
for pattern in "${PAGE_THRESHOLD[@]}"; do
  # The `\[client-error\]` marker itself is the legitimate beacon-volume
  # signal — count it against the full $LOGS. Every other pattern runs
  # against $LOGS_NO_BEACON so beacon-controlled text can't double-count.
  if [ "$pattern" = '\[client-error\]' ]; then
    n="$(printf '%s\n' "$LOGS" | grep -cE "$pattern" || true)"
  else
    n="$(printf '%s\n' "$LOGS_NO_BEACON" | grep -cE "$pattern" || true)"
  fi
  if [ "$n" -gt 0 ]; then
    threshold_total=$((threshold_total + n))
    threshold_summary+=("${pattern} x${n}")
  fi
done
if [ "$threshold_total" -ge "$THRESHOLD" ]; then
  alerts+=("logs flakes (>=${THRESHOLD} in ${WINDOW}): ${threshold_summary[*]}")
fi

# Count-then-push-once: ONE summary message per run.
if [ "${#alerts[@]}" -gt 0 ]; then
  text="Caliber alert ($(date -u +%FT%TZ))"
  for a in "${alerts[@]}"; do
    text="$text
- $a"
  done
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="$text" > /dev/null
  echo "alert pushed: ${#alerts[@]} finding(s)"
else
  echo "ok: no findings"
fi
