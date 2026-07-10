"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { SummaryStrip } from "./SummaryStrip";
import { FilterChips, FEED_FILTERS, type FeedFilter } from "./FilterChips";
import { JobRow } from "./JobRow";
import type { Job, SummaryStripStats } from "../../../types";

export type JobRowAction = "open" | "save" | "dismiss";

export interface JobFeedProps {
  jobs: Job[];
  filter: FeedFilter;
  onFilterChange(f: FeedFilter): void;
  /** Server-computed Feed hero numbers (api-contract.md `GET /api/jobs`
   * `stats`) — never derived client-side from the (paginated) `jobs` page. */
  stats: SummaryStripStats;
  loading: boolean;
  error?: string;
  /** Not in the frozen component-inventory signature; added so the
   * "error+retry" story state has something to call — optional, additive. */
  onRetry?(): void;
  onRowAction(id: string, action: JobRowAction): void;
}

function matchesFilter(job: Job, filter: FeedFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "new":
      return job.isNew;
    case "verified":
      return job.legitimacy.tier === "verified";
    case "suspicious":
      return job.legitimacy.tier === "suspicious";
    case "remote":
      return job.persona === "remote";
    case "fit4":
      return job.score >= 4;
  }
}

function computeCounts(jobs: Job[]): Record<FeedFilter, number> {
  const counts = {} as Record<FeedFilter, number>;
  for (const f of FEED_FILTERS) counts[f.value] = jobs.filter((j) => matchesFilter(j, f.value)).length;
  return counts;
}

// JobFeed (FeedStream) — the live scored feed (F2), §11.8's hero: SummaryStrip
// + FilterChips + JobRow[] + a "new since last visit" divider. `stats` is
// server-computed and required; only the FilterChips counts (a legitimate
// client-side tally of the currently-loaded `jobs`) are derived here.
export function JobFeed({ jobs, filter, onFilterChange, stats, loading, error, onRetry, onRowAction }: JobFeedProps) {
  const counts = computeCounts(jobs);
  const filtered = jobs.filter((j) => matchesFilter(j, filter));
  const newJobs = filtered.filter((j) => j.isNew);
  const olderJobs = filtered.filter((j) => !j.isNew);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SummaryStrip stats={stats} />
      <FilterChips active={filter} counts={counts} onChange={onFilterChange} />

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: 88,
                borderRadius: "var(--radius-lg)",
                background: "var(--surface-sunken)",
                animation: "caliber-pulse 1.1s ease-in-out infinite alternate",
              }}
            />
          ))}
        </div>
      )}

      {!loading && error && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "40px 20px",
            textAlign: "center",
          }}
        >
          <Icon name="triangle-alert" size={22} style={{ color: "var(--danger-ink)" }} />
          <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>{error}</span>
          <Button variant="secondary" onClick={onRetry} iconLeft="refresh-cw">
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center", font: "var(--type-body)", color: "var(--text-muted)" }}>
          {jobs.length === 0 ? "No jobs scanned yet — run a search to populate your feed." : "No jobs match this filter."}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {newJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onOpen={() => onRowAction(job.id, "open")}
              onSave={() => onRowAction(job.id, "save")}
              onDismiss={() => onRowAction(job.id, "dismiss")}
            />
          ))}
          {newJobs.length > 0 && olderJobs.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "6px 0",
                font: "var(--type-eyebrow)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-caps)",
                color: "var(--text-faint)",
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
              Earlier
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          )}
          {olderJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onOpen={() => onRowAction(job.id, "open")}
              onSave={() => onRowAction(job.id, "save")}
              onDismiss={() => onRowAction(job.id, "dismiss")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
