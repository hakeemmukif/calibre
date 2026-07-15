"use client";
// F2 — the A·Signal-Pill hero feed, wired to the real backend
// (component-inventory.md AppShellHeader/JobFeed; api-contract.md §3
// "GET /api/jobs"). "save"/"dismiss" row actions and the URL-eval bar have no
// route in the frozen v1 contract (deferred per api-contract.md §5) — they
// are inert no-ops here, not invented endpoints. "Scan now" starts a real
// POST /api/search run and navigates to its /scans/:id home (D7) — the
// in-feed live scan overlay is retired.
import * as React from "react";
import { useRouter } from "next/navigation";
import { PersonaToggle } from "@/caliber-ui/compositions/Shell/PersonaToggle";
import { UrlEvalBar } from "@/caliber-ui/compositions/Shell/UrlEvalBar";
import { NotificationBell } from "@/caliber-ui/compositions/Shell/NotificationBell";
import { EvalResultCard } from "@/caliber-ui/compositions/Eval/EvalResultCard";
import { JobFeed, type JobRowAction } from "@/caliber-ui/compositions/Feed/JobFeed";
import { ScoringStatusCard } from "@/caliber-ui/compositions/Feed/ScoringStatusCard";
import { Button } from "@/caliber-ui/components/Button";
import type { FeedFilter } from "@/caliber-ui/compositions/Feed/FilterChips";
import { getJobs, deleteJob } from "@/features/feed/client";
import { startSearch } from "@/features/search/client";
import { ApiError } from "@/features/http";
import { useUrlChecks } from "@/features/url-check/checksStore";
import type { Job, Persona, SummaryStripStats } from "@/types";

const EMPTY_STATS: SummaryStripStats = { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0, excluded: 0 };

// alreadyKnown names the job's actual scope (spec §3 step 6) — re-pasting a
// URL that was previously pasted is the most common alreadyKnown case, so
// "pasted" is a real scope here, not an impossible one.
function scopeLabel(p: Persona): string {
  switch (p) {
    case "remote":
      return "Remote · global";
    case "local":
      return "Malaysia · local";
    case "pasted":
      return "Pasted";
  }
}

export default function FeedPage() {
  const router = useRouter();
  const [persona, setPersona] = React.useState<Persona>("remote");
  const [filter, setFilter] = React.useState<FeedFilter>("all");
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [stats, setStats] = React.useState<SummaryStripStats>(EMPTY_STATS);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | undefined>();
  const [scanLaunching, setScanLaunching] = React.useState(false);

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

  const checks = useUrlChecks();

  const prevDone = React.useRef(0);
  React.useEffect(() => {
    if (checks.doneCount > prevDone.current) { prevDone.current = checks.doneCount; void load(); }
  }, [checks.doneCount, load]);

  const latestPaste = checks.runs.find((r) => r.origin === "paste");
  const urlEvalStatus: "idle" | "evaluating" | "success" | "error" =
    !latestPaste ? "idle"
    : latestPaste.phase === "done" ? "success"
    : latestPaste.phase === "failed" || latestPaste.phase === "needsText" ? "error"
    : "evaluating";

  function handleRowAction(id: string, action: JobRowAction) {
    if (action === "open") {
      router.push(`/jobs/${id}`);
      return;
    }
    if (action === "dismiss" && persona === "pasted") {
      void handleDeleteJob(id);
      return;
    }
    // "save"/scanned-job "dismiss": no backend route in api-contract.md v1 — deferred.
  }

  async function handleDeleteJob(id: string) {
    if (!window.confirm("Delete this pasted job? This can't be undone.")) return;
    try {
      await deleteJob(id);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the job.");
    }
  }

  // "Scan now" → start the run and hand off to its /scans/:id home (D7). A
  // 409 CONFLICT means a run is already active for this persona — reattach by
  // routing to it instead of erroring (mirrors scans/page.tsx's handling).
  async function handleScanNow() {
    setScanLaunching(true);
    setError(undefined);
    try {
      const run = await startSearch({ persona });
      router.push(`/scans/${run.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "CONFLICT") {
        const activeRunId =
          typeof err.details === "object" && err.details !== null && "activeRunId" in err.details
            ? (err.details as { activeRunId: unknown }).activeRunId
            : undefined;
        if (typeof activeRunId === "string") {
          router.push(`/scans/${activeRunId}`);
          return;
        }
      }
      setError(err instanceof Error ? err.message : "Couldn't start scan.");
    } finally {
      setScanLaunching(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
          <PersonaToggle value={persona} onChange={setPersona} />
          <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <UrlEvalBar
              status={urlEvalStatus}
              stageText={latestPaste?.stage ?? undefined}
              error={latestPaste?.error?.message}
              showPasteBox={latestPaste?.phase === "needsText"}
              onSubmit={(url, text) => checks.submit(url, text)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NotificationBell count={0} />
            {persona !== "pasted" && (
              <Button
                variant="primary"
                iconLeft="search"
                onClick={() => void handleScanNow()}
                disabled={scanLaunching}
              >
                Scan now
              </Button>
            )}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <ScoringStatusCard
            runs={checks.runs}
            onOpen={(jobId) => router.push(`/jobs/${jobId}`)}
            onRetry={(key) => checks.retryWithText(key, "")}
            onPasteText={() => { /* paste box already shown via showPasteBox on needsText */ }}
            onDismiss={checks.dismiss}
          />
        </div>
        {(() => {
          const latestDone = checks.runs.find((r) => r.origin === "paste" && r.phase === "done" && r.job);
          if (!latestDone?.job) return null;
          return (
            <div style={{ marginBottom: 16, display: "flex", justifyContent: "center" }}>
              <EvalResultCard
                job={latestDone.job}
                onOpen={() => router.push(`/jobs/${latestDone.job!.id}`)}
                onSave={() => {}}
                onTailor={() => router.push(`/jobs/${latestDone.job!.id}/tailor`)}
                onDismiss={() => checks.dismiss(latestDone.key)}
                alreadyKnownScopeLabel={latestDone.alreadyKnown ? scopeLabel(latestDone.job.persona) : undefined}
              />
            </div>
          );
        })()}
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
