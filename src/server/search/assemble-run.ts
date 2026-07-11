// DB row → wire `SearchRun` (api-contract.md §2). Discovery-only (B5): no
// job_scores exist yet, so `stats.worth` (count of Apply/Consider verdicts)
// is always 0 — B6 populates it. `progress` is always null here — live
// progress is ephemeral (server/runs/registry.ts), never persisted; this
// view is the polling/terminal snapshot. `sources` (SourceRef ids in scope)
// is read off `stats.perSource`, which run.ts seeds with every resolved
// source at run start — `search_runs` has no separate `sources` column.
import type { SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { SearchRun } from "@/types";

export function toSearchRun(row: SearchRunRow): SearchRun {
  const persona = row.personas[0];
  if (!persona) {
    throw new Error(`search_runs row ${row.id} has an empty personas[] — cannot derive the wire persona`);
  }

  return SearchRun.parse({
    id: row.id,
    status: row.status,
    persona,
    sources: row.stats.perSource.map((p) => p.sourceId),
    progress: null,
    stats: { scanned: row.stats.scanned, worth: 0, ghosts: row.stats.ghosts },
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    error: row.error ?? null,
  });
}
