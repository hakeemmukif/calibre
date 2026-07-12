"use client";
// F2 — the A·Signal-Pill hero feed, wired to the real backend
// (component-inventory.md AppShellHeader/JobFeed; api-contract.md §3
// "GET /api/jobs"). "save"/"dismiss" row actions and the URL-eval bar have no
// route in the frozen v1 contract (deferred per api-contract.md §5) — they
// are inert no-ops here, not invented endpoints. "Scan now" drives a real
// POST /api/search run via useScanRun and renders the ScanProgress overlay
// off its SSE stream (jobs stream in live; the feed refetches on `done`).
import * as React from "react";
import { useRouter } from "next/navigation";
import { PersonaToggle } from "@/caliber-ui/compositions/Shell/PersonaToggle";
import { UrlEvalBar } from "@/caliber-ui/compositions/Shell/UrlEvalBar";
import { NotificationBell } from "@/caliber-ui/compositions/Shell/NotificationBell";
import { EvalResultCard } from "@/caliber-ui/compositions/Eval/EvalResultCard";
import { JobFeed, type JobRowAction } from "@/caliber-ui/compositions/Feed/JobFeed";
import { ScanProgress } from "@/caliber-ui/compositions/Feed/ScanProgress";
import { Button } from "@/caliber-ui/components/Button";
import type { FeedFilter } from "@/caliber-ui/compositions/Feed/FilterChips";
import { getJobs, deleteJob } from "@/features/feed/client";
import { useScanRun } from "@/features/search/useScanRun";
import { takeScanHandoff, type ScanHandoff } from "@/features/search/scanHandoff";
import { useUrlCheck } from "@/features/url-check/useUrlCheck";
import type { Job, Persona, SummaryStripStats } from "@/types";

const EMPTY_STATS: SummaryStripStats = { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0, excluded: 0 };

// alreadyKnown names the job's actual scope (spec §3 step 6) — a pasted
// job that resolved to an existing job can never itself be "pasted".
function scopeLabel(p: Persona): string {
  switch (p) {
    case "remote":
      return "Remote · global";
    case "local":
      return "Malaysia · local";
    case "pasted":
      throw new Error("alreadyKnown job cannot itself be in the Pasted scope");
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

  const scan = useScanRun({
    // Each scored job streams in as it's found; prepend, deduped by id (the
    // registry has no replay buffer, so `done` still triggers an authoritative
    // refetch below — this is the live preview, not the source of truth).
    onJob: (job) => setJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [job, ...prev])),
    onDone: () => void load(),
  });

  React.useEffect(() => {
    void load();
  }, [load]);

  // Résumé-upload handoff: attach to the just-started run for the active
  // persona instead of starting a new one. Read INSIDE the effect (never
  // during render — `sessionStorage` is undefined under SSR), and only on the
  // first run (the ref survives StrictMode's dev remount, which tears the
  // hook's SSE subscription down via its cleanup then re-runs this effect).
  // `takeScanHandoff()` clears storage, so re-reading would come back empty;
  // caching the run ids in the ref lets the second run RE-subscribe
  // (subscribeTo is idempotent) instead of leaving the overlay stuck.
  const handoffRef = React.useRef<ScanHandoff | null>(null);

  React.useEffect(() => {
    if (handoffRef.current === null) handoffRef.current = takeScanHandoff();
    const runId = handoffRef.current[persona];
    if (runId) scan.subscribeTo(runId);
    // Mount-only: the handoff is consumed on arrival, not on persona change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlCheck = useUrlCheck();

  // Feed refreshes on completion only while the Pasted segment is active
  // (spec §12) — a paste made while viewing Remote/Local shouldn't yank
  // the visible list.
  React.useEffect(() => {
    if (urlCheck.state.status === "done" && persona === "pasted") void load();
  }, [urlCheck.state.status, persona, load]);

  const urlEvalStatus: "idle" | "evaluating" | "success" | "error" =
    urlCheck.state.status === "running"
      ? "evaluating"
      : urlCheck.state.status === "done"
        ? "success"
        : urlCheck.state.status === "needsText" || urlCheck.state.status === "failed"
          ? "error"
          : "idle";

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

  // Dismissing while the run is still "running"/"starting": unsubscribe
  // (the run keeps going server-side) and refetch now, so the feed shows
  // whatever has already been scored instead of only the SSE-streamed
  // preview jobs. `done`/`error` dismissal stays plain `scan.reset` — `done`
  // already refetched via `onDone` above.
  function handleDismissRunning() {
    scan.reset();
    void load();
  }

  const scanActive = scan.state.status !== "idle";
  // "starting" has no visual of its own — show the running view until the
  // first progress event lands. Narrows to exactly what ScanProgress accepts.
  const overlayStatus: "running" | "done" | "error" =
    scan.state.status === "done" ? "done" : scan.state.status === "error" ? "error" : "running";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
          <PersonaToggle value={persona} onChange={setPersona} />
          <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <UrlEvalBar
              status={urlEvalStatus}
              stageText={urlCheck.state.stage ?? undefined}
              error={urlCheck.state.check?.error?.message ?? (urlCheck.state.status === "failed" ? "Couldn't check that URL." : undefined)}
              showPasteBox={urlCheck.state.status === "needsText"}
              onSubmit={(url, text) => void urlCheck.submit(url, text)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NotificationBell count={0} />
            {persona !== "pasted" && (
              <Button
                variant="primary"
                iconLeft="search"
                onClick={() => void scan.start(persona)}
                disabled={scan.state.status === "starting" || scan.state.status === "running"}
              >
                Scan now
              </Button>
            )}
          </div>
        </div>
        {urlCheck.state.status === "done" && urlCheck.state.job && (
          <div style={{ marginBottom: 16, display: "flex", justifyContent: "center" }}>
            <EvalResultCard
              job={urlCheck.state.job}
              onOpen={() => router.push(`/jobs/${urlCheck.state.job!.id}`)}
              onSave={() => {}}
              onTailor={() => router.push(`/jobs/${urlCheck.state.job!.id}/tailor`)}
              onDismiss={() => urlCheck.dismiss()}
              alreadyKnownScopeLabel={
                urlCheck.state.check?.alreadyKnown ? scopeLabel(urlCheck.state.job.persona) : undefined
              }
            />
          </div>
        )}
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

      {scanActive && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            background: "var(--scrim, rgba(15, 18, 28, 0.55))",
            zIndex: 50,
          }}
        >
          <div style={{ width: "100%", maxWidth: 440 }}>
            <ScanProgress
              status={overlayStatus}
              stages={scan.state.stages}
              stats={scan.state.stats}
              error={scan.state.error}
              onClose={overlayStatus === "running" ? handleDismissRunning : scan.reset}
            />
          </div>
        </div>
      )}
    </div>
  );
}
