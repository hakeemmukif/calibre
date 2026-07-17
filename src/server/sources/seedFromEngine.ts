// Task 2.5 — composes a validated jobhive candidate into a `sources` row for
// `sourcesRepo.bulkInsert` (repos/sources.ts). Mirrors the exact shape spec
// 2026-07-16-remote-startup-niche-source-expansion-design.md §4.3 shows
// under "A `sources` row after the engine" (id "gh:vercel", `config` carrying
// connector/slug + provenance/health fields) — no schema migration, health
// stays in the existing json `config` column until an admin UI needs to
// query it (spec: "promote status/lastValidatedAt to columns when the admin
// UI needs them").
//
// `status` is a small explicit enum. Seeding always writes "active"; "dead"
// exists only for the freshness loop (task 2.6, freshness.ts, spec step 5: 3
// consecutiveFailures -> 'dead' + re-detection) to flip.
//
// This module composes rows for the *remote* persona only (spec §1: "Niche |
// Global remote startups, all job functions ... SEA-local persona
// retained") — the SEA-local persona is grown separately (hand-curated /
// Glints), not through this jobhive/niche engine.
import type { JobhiveAts, JobhiveRow } from "./jobhive";
import type { ValidationResult } from "./validate";
import type { NewSource } from "../persistence/repos/sources";
import type { SourceGeo } from "../search/geo";

export type SourceHealthStatus = "active" | "dead";

export interface SourceConfig {
  connector: JobhiveAts;
  slug: string;
  geo: SourceGeo;
  provenance: string[];
  companyDomain: string;
  lastValidatedAt: number;
  jobCount: number;
  consecutiveFailures: number;
  status: SourceHealthStatus;
}

// Every engine row gets "anywhere", not an operator-judged per-company value
// (unlike the hand-curated seed.ts rows, which mix "anywhere"/"restricted"
// per company). Spec §4.3's own "sources row after the engine" example
// hardcodes `"geo": { "scope": "anywhere" }`, and step 2 says explicitly:
// "Do not pre-filter for remote-only companies — seed the company and let
// the existing per-posting geo filter ... decide visibility per posting."
// The engine has no per-company signal to pick "restricted" from, and the
// spec makes "anywhere" the one correct source-level value for every row it
// seeds — so this is a cited constant, not a silent default.
const ENGINE_SOURCE_GEO: SourceGeo = { scope: "anywhere" };

// Matches the id prefixes seed.ts's hand-curated rows already use ("gh-" for
// greenhouse, full connector name for lever/ashby — see gh-stripe vs
// lever-toptal / ashby-ramp), separated with ":" per the spec's own example
// id "gh:vercel" rather than "-" (hand-seeded rows use "-"; this engine's
// output follows the spec literally instead of inventing a match to the
// hand-seeded convention).
const ID_PREFIX: Record<JobhiveAts, string> = {
  greenhouse: "gh",
  lever: "lever",
  ashby: "ashby",
};

/** The single source of `sources.id` for engine-composed rows — growth.ts imports this rather than duplicating ID_PREFIX. */
export function engineSourceId(ats: JobhiveAts, slug: string): string {
  return `${ID_PREFIX[ats]}:${slug}`;
}

/**
 * Composes a `sources` row from a jobhive candidate, its validation result,
 * a provenance list (e.g. ["jobhive", "yc-oss"]), and the company's
 * normalized domain. Only an `ok: true` validation may be seeded — a
 * not-ok validation passed in throws rather than being silently skipped.
 */
export function seedFromEngine(
  row: JobhiveRow,
  validation: ValidationResult,
  provenance: string[],
  companyDomain: string,
): NewSource {
  if (!validation.ok) {
    throw new Error(
      `seedFromEngine: cannot seed "${row.name}" (${row.ats}:${row.slug}) from a not-ok validation ` +
        `(status=${validation.status}, reason=${validation.reason})`,
    );
  }
  if (!provenance.length) {
    throw new Error(`seedFromEngine: "${row.name}" (${row.ats}:${row.slug}) has an empty provenance list`);
  }
  if (!companyDomain) {
    throw new Error(`seedFromEngine: "${row.name}" (${row.ats}:${row.slug}) is missing companyDomain`);
  }

  return {
    id: engineSourceId(row.ats, row.slug),
    name: row.name,
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: {
      connector: row.ats,
      slug: row.slug,
      geo: ENGINE_SOURCE_GEO,
      provenance,
      companyDomain,
      lastValidatedAt: validation.lastValidatedAt,
      jobCount: validation.jobCount,
      consecutiveFailures: 0,
      status: "active",
    },
  };
}
