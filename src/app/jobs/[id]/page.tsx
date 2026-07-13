"use client";
// F3/F4/F6 launcher — the full posting view, wired to the real backend
// (component-inventory.md JobDetail; api-contract.md §1 "F2/F3 GET
// /api/jobs/:id"). F3 apply-out: a real `<a target="_blank" rel="noopener"
// href={job.applyUrl}>` click, built programmatically since JobDetail's
// frozen `onApply(): void` prop is a plain callback, not a render slot —
// `job.applyUrl` is required + already resolved (features/feed/assemble.ts),
// so this is a client-side-only action, no server round-trip.
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { JobDetail } from "@/caliber-ui/compositions/Detail/JobDetail";
import { ReScoringBanner } from "@/caliber-ui/compositions/Detail/ReScoringBanner";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getJob } from "@/features/feed/client";
import { useUrlChecks } from "@/features/url-check/checksStore";
import { listApplications, markApplied } from "@/features/applied/client";
import type { Application, Job } from "@/types";

function openApplyUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = React.useState<Job | null>(null);
  const [applied, setApplied] = React.useState<Application | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const checks = useUrlChecks();
  // Newest re-evaluate run for this job (runs are newest-first) — INCLUDING a
  // failed one, so a newer success supersedes an older failure instead of the
  // error caption sticking forever.
  const myRun = checks.runs.find((r) => r.origin === "reevaluate" && r.jobId === id);
  const otherActive = checks.active.filter((r) => r.jobId !== id).length;
  const evaluateStatus: "idle" | "evaluating" | "error" =
    !myRun || myRun.phase === "done" ? "idle" : myRun.phase === "failed" ? "error" : "evaluating";

  // When our re-score completes, adopt the fresh job the store fetched.
  React.useEffect(() => {
    if (myRun?.phase === "done" && myRun.job && myRun.job !== job) setJob(myRun.job);
  }, [myRun?.phase, myRun?.job, job]);

  const load = React.useCallback(async () => {
    setError(undefined);
    try {
      const [fetchedJob, applications] = await Promise.all([getJob(id), listApplications({ limit: 100 })]);
      setJob(fetchedJob);
      // No `jobId` filter on GET /api/applications (api-contract.md §3) — v1
      // scale makes a bounded list-and-find acceptable; documented limitation.
      setApplied(applications.items.find((a) => a.jobId === id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this posting.");
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
        <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--danger-soft)",
              color: "var(--danger-ink)",
            }}
          >
            <Icon name="triangle-alert" size={16} />
            <span style={{ font: "var(--type-body)" }}>{error}</span>
          </div>
          <Button variant="secondary" iconLeft="refresh-cw" style={{ marginTop: 12 }} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!job) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
        {myRun && (myRun.phase === "fetching" || myRun.phase === "scoring" || myRun.phase === "done") && (
          <ReScoringBanner phase={myRun.phase} otherActive={otherActive} />
        )}
        <JobDetail
          job={job}
          applied={applied}
          onApply={() => openApplyUrl(job.applyUrl)}
          onTailor={() => router.push(`/jobs/${job.id}/tailor`)}
          onAnswerQuestions={() => router.push(`/jobs/${job.id}/questions`)}
          onEvaluate={() => checks.submitEvaluate(job.id)}
          evaluateStatus={evaluateStatus}
          onMarkApplied={async () => {
            const app = await markApplied({ jobId: job.id });
            setApplied(app);
          }}
        />
      </div>
    </div>
  );
}
