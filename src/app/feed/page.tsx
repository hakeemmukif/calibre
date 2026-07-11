"use client";
// F2 — the A·Signal-Pill hero feed, wired to the real backend
// (component-inventory.md AppShellHeader/JobFeed; api-contract.md §3
// "GET /api/jobs"). "save"/"dismiss" row actions and the URL-eval bar have no
// route in the frozen v1 contract (deferred per api-contract.md §5) — they
// are inert no-ops here, not invented endpoints.
import * as React from "react";
import { useRouter } from "next/navigation";
import { AppShellHeader } from "@/caliber-ui/compositions/Shell/AppShellHeader";
import { JobFeed, type JobRowAction } from "@/caliber-ui/compositions/Feed/JobFeed";
import type { FeedFilter } from "@/caliber-ui/compositions/Feed/FilterChips";
import { getJobs } from "@/features/feed/client";
import type { Job, Persona, SummaryStripStats } from "@/types";

const EMPTY_STATS: SummaryStripStats = { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0 };

export default function FeedPage() {
  const router = useRouter();
  const [persona, setPersona] = React.useState<Persona>("remote");
  const [filter, setFilter] = React.useState<FeedFilter>("all");
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [stats, setStats] = React.useState<SummaryStripStats>(EMPTY_STATS);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await getJobs({ persona });
      setJobs(result.items);
      setStats(result.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the feed.");
    } finally {
      setLoading(false);
    }
  }, [persona]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function handleRowAction(id: string, action: JobRowAction) {
    if (action === "open") router.push(`/jobs/${id}`);
    // "save"/"dismiss": no backend route in api-contract.md v1 — deferred.
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <AppShellHeader persona={persona} onPersona={setPersona} evalStatus="idle" onEval={() => {}} alertCount={0} />
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <JobFeed
          jobs={jobs}
          filter={filter}
          onFilterChange={setFilter}
          stats={stats}
          loading={loading}
          error={error}
          onRetry={load}
          onRowAction={handleRowAction}
        />
      </div>
    </div>
  );
}
