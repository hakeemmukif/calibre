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
import { getJob } from "@/features/feed/client";
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

  const load = React.useCallback(async () => {
    const [fetchedJob, applications] = await Promise.all([getJob(id), listApplications({ limit: 100 })]);
    setJob(fetchedJob);
    // No `jobId` filter on GET /api/applications (api-contract.md §3) — v1
    // scale makes a bounded list-and-find acceptable; documented limitation.
    setApplied(applications.items.find((a) => a.jobId === id));
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!job) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
        <JobDetail
          job={job}
          applied={applied}
          onApply={() => openApplyUrl(job.applyUrl)}
          onTailor={() => router.push(`/jobs/${job.id}/tailor`)}
          onAnswerQuestions={() => router.push(`/jobs/${job.id}/questions`)}
          onMarkApplied={async () => {
            const app = await markApplied({ jobId: job.id });
            setApplied(app);
          }}
        />
      </div>
    </div>
  );
}
