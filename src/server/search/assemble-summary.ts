// DB row → wire `SearchRunSummary`/`ScanDetail` (api-contract.md §2/§3 list +
// detail views). `ScanDetail` is `SearchRunSummary` + `error` + `results[]` —
// used by the GET list route and the `[id]` JSON snapshot respectively.
import type { SearchRunRow, SearchRunSummaryRow } from "@/server/persistence/repos/searchRuns";
import { ScanDetail, SearchRunSummary, type ScanDetail as TDetail, type SearchRunSummary as TSummary } from "@/types";

function personaOf(personas: SearchRunRow["personas"], id: string): "remote" | "local" {
  const p = personas[0];
  if (!p) throw new Error(`search_runs row ${id} has an empty personas[] — cannot derive the wire persona`);
  return p;
}

function statsOf(s: SearchRunRow["stats"]) {
  return {
    scanned: s.scanned, matched: s.matched, scored: s.scored, worth: s.worth, ghosts: s.ghosts,
    unscored: s.unscored ?? 0, capStopped: s.capStopped ?? false,
    discoverMs: s.discoverMs ?? 0, scoreMs: s.scoreMs ?? 0, costUsd: s.costUsd ?? 0,
    policyVersion: s.policyVersion ?? "legacy",
  };
}

export function toSearchRunSummary(row: SearchRunSummaryRow): TSummary {
  return SearchRunSummary.parse({
    id: row.id, status: row.status, persona: personaOf(row.personas, row.id), resumeName: row.resumeName,
    startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    stats: statsOf(row.stats),
  });
}

export function toScanDetail(row: SearchRunRow & { resumeName: string }): TDetail {
  return ScanDetail.parse({
    id: row.id, status: row.status, persona: personaOf(row.personas, row.id), resumeName: row.resumeName,
    startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    stats: statsOf(row.stats), error: row.error ?? null, results: row.results,
  });
}
