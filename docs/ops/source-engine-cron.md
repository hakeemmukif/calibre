# Source-engine cron (operator VPS steps)

Operational schedule for the source-health loop and the growth loop (Track O,
plan `docs/superpowers/plans/2026-07-17-operational-and-debt.md`). These are
**operator steps run on the box** — they are not wired by the app. Both use
`flock -n` (non-blocking) so a slow run never overlaps the next one.

Paths below assume the deploy checkout at `/opt/caliber` (adjust to match the
box). The scripts resolve `--env-file-if-exists=.env.local` exactly like
`sources:engine`, so run them from the checkout root (`cd` first) — the
freshness `--report` default is repo-relative.

## Weekly freshness — heal or visibly disable dead slugs (O.1)

`runFreshnessPass` re-validates every source; a slug that fails 3 times in a
row flips to `status:'dead'` (surfaced on the admin sources-health page). Runs
Sunday 03:00.

```cron
0 3 * * 0 cd /opt/caliber && /usr/bin/flock -n /tmp/caliber-freshness.lock npm run sources:freshness -- --report=docs/superpowers/reports/freshness-run-latest.md >> /var/log/caliber-freshness.log 2>&1
```

A `FreshnessPassError` (a row too corrupt to process) still prints and writes
the partial run summary for every row that *did* process, then exits non-zero —
check the exit code / log, the ~800 healthy rows are not lost.

## Daily growth — seed newly-added YC companies (O.3)

`sources:growth` reads yc-oss `changes/latest.json` (the most-recent diff only)
and runs just the added companies through match → identity → validate → seed.
Runs 03:17 daily (offset off the engine's own 03:00 slot).

```cron
17 3 * * * cd /opt/caliber && /usr/bin/flock -n /tmp/caliber-growth.lock npm run sources:growth >> /var/log/caliber-growth.log 2>&1
```

### Gap-day backstop (important)

`latest.json` is a single most-recent-diff feed with **no lookback window** — a
missed run (box down, deploy window) loses that day's additions permanently
from this path. Two backstops:

1. **Occasional full re-seed.** Run a full engine pass roughly monthly; it is
   idempotent (`onConflictDoNothing`) and re-absorbs anything growth missed:

   ```
   cd /opt/caliber && npm run sources:engine -- --seed
   ```

2. **Batch days route here automatically.** `sources:growth` aborts loudly when
   a diff has more than `GROWTH_MAX_FRESH` (25) new companies — a YC batch drop
   belongs to the full seeder, not the incremental daily path. When you see that
   abort in the log, run the full re-seed above; it recovers the whole batch.
