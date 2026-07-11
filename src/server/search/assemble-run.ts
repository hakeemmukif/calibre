// DB row → wire `SearchRun` (api-contract.md §2). `stats.worth` (count of
// Apply/Consider verdicts, from the scoring phase — B6) and `.ghosts` come
// straight off the persisted `search_runs.stats` row.ts now writes.
// `progress` is always null here — live progress is ephemeral
// (server/runs/registry.ts), never persisted; this view is the
// polling/terminal snapshot. `sources` (SourceRef ids in scope) is read off
// `stats.perSource`, which run.ts seeds with every resolved source at run
// start — `search_runs` has no separate `sources` column.
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
    stats: { scanned: row.stats.scanned, worth: row.stats.worth, ghosts: row.stats.ghosts },
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    error: row.error ?? null,
  });
}
