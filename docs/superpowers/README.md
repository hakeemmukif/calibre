# docs/superpowers — provenance index

`specs/` are design docs — truth at the time they were written; the architecture docs and the code supersede them. `plans/` are implementation plans, `reports/` are verification runs, and `handoffs/` are session handoffs. On overlapping topics, the newest date wins. Current-state truth lives in `docs/architecture/`, not here.

## specs/

| Date | Spec | Status | Shipped as |
|---|---|---|---|
| 2026-07-11 | [caliber-standalone-design](specs/2026-07-11-caliber-standalone-design.md) | CURRENT | authoritative product design; §1 non-goals superseded by multi-tenant + credits work |
| 2026-07-11 | [manual-url-scan-design](specs/2026-07-11-manual-url-scan-design.md) | SUPERSEDED | by [2026-07-12-pasted-job-ingestion-design.md](specs/2026-07-12-pasted-job-ingestion-design.md) |
| 2026-07-12 | [pasted-job-ingestion-design](specs/2026-07-12-pasted-job-ingestion-design.md) | SHIPPED | `src/server/url-check` |
| 2026-07-12 | [remote-local-eligibility-design](specs/2026-07-12-remote-local-eligibility-design.md) | SHIPPED | eligibility resolver in `server/score` |
| 2026-07-13 | [parallel-scoring-design](specs/2026-07-13-parallel-scoring-design.md) | SHIPPED | batched `/api/jobs/check` worker |
| 2026-07-14 | [remote-fit-criteria-design](specs/2026-07-14-remote-fit-criteria-design.md) | SHIPPED | `tzBand`/`scheduleFlex` in `server/score` |
| 2026-07-14 | [resume-extraction-v2-standard-design](specs/2026-07-14-resume-extraction-v2-standard-design.md) | SHIPPED | `Resume.projects`/`certifications`/`languages` |
| 2026-07-15 | [scan-observability-design](specs/2026-07-15-scan-observability-design.md) | SHIPPED | SSE `source`/`jobPhase`/`snapshot` events + Scans compositions |
| 2026-07-15 | [tailor-correlation-engine-design](specs/2026-07-15-tailor-correlation-engine-design.md) | SHIPPED | `correlation_reports` repo |
| 2026-07-16 | [membership-credits-guardrails-design](specs/2026-07-16-membership-credits-guardrails-design.md) | SHIPPED | `src/server/credits` + `credit_ledger` |
| 2026-07-16 | [membership-credits-handoff](specs/2026-07-16-membership-credits-handoff.md) | SHIPPED | `src/server/credits` + `credit_ledger` |
| 2026-07-16 | [remote-startup-niche-source-expansion-design](specs/2026-07-16-remote-startup-niche-source-expansion-design.md) | SHIPPED | sources config |
| 2026-07-16 | [sqlite-migration-design](specs/2026-07-16-sqlite-migration-design.md) | SHIPPED | SQLite/libsql everywhere |
| 2026-07-16 | [tailor-phase-2-handoff](specs/2026-07-16-tailor-phase-2-handoff.md) | SHIPPED | `TailorReport` composition |
| 2026-07-16 | [tailor-phase-2-report-ui-design](specs/2026-07-16-tailor-phase-2-report-ui-design.md) | SHIPPED | `TailorReport` composition |
| 2026-07-17 | [global-postings-pool-architecture](specs/2026-07-17-global-postings-pool-architecture.md) | SHIPPED (architecture doc, not a design spec) | `postings` table + `src/server/pool` |
| 2026-07-21 | [admin-pool-tab-design](specs/2026-07-21-admin-pool-tab-design.md) | SHIPPED | `/admin/pool` |
| 2026-07-21 | [analytics-posthog-design](specs/2026-07-21-analytics-posthog-design.md) | SHIPPED | `features/analytics` |
| 2026-07-21 | [raw-crawl-archive-design](specs/2026-07-21-raw-crawl-archive-design.md) | SHIPPED | crawl archive tee |
| 2026-07-21 | [worldwide-tzband-design](specs/2026-07-21-worldwide-tzband-design.md) | SHIPPED | worldwide band in `TzBand` |

## plans/

39 dated implementation plans, historical — step-by-step build breakdowns for the specs above; see the specs table for what each ultimately shipped as.

## reports/

9 verification-run reports from the 2026-07-17 connector/pool build push (dry-runs, seed runs, live connector verification, matching stress test).

## handoffs/

1 session handoff (`2026-07-13-parallel-scoring.md`); paired design+handoff docs for later work (membership-credits, tailor-phase-2) live under `specs/` instead.
