"use client";
// F6 — diff-review résumé tailoring, wired to the real backend
// (component-inventory.md §3 TailorResume; api-contract.md §3 "POST
// /api/tailor", "GET /api/tailor/:id", "POST /api/tailor/:id/finalize",
// "GET /api/tailor/:id/pdf"). TailorResume is purely presentational — this
// page owns the whole state machine (configuring -> generating -> review ->
// saved/exporting), polling `GET /api/tailor/:id` until the run terminates.
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { TailorResume, type TailorUiState } from "@/caliber-ui/compositions/Tailor/TailorResume";
import { finalizeTailor, getCorrelate, getTailor, startCorrelate, startTailor, tailorPdfUrl } from "@/features/tailor/client";
import { ApiError } from "@/features/http";
import { showDenial } from "@/features/credits/creditsStore";
import { getJob } from "@/features/feed/client";
import { getResume } from "@/features/resume/client";
import type { CorrelationReport, Job, Resume, TailoredResume } from "@/types";

const POLL_INTERVAL_MS = 1200;

export default function TailorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = React.useState<Job | null>(null);
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [tailored, setTailored] = React.useState<TailoredResume | undefined>();
  const [report, setReport] = React.useState<CorrelationReport | undefined>();
  const [status, setStatus] = React.useState<TailorUiState>("configuring");
  const [error, setError] = React.useState<string | undefined>();
  const [needsScoreMessage, setNeedsScoreMessage] = React.useState<string | undefined>();
  const [accepted, setAccepted] = React.useState<boolean[]>([]);

  React.useEffect(() => {
    void Promise.all([getJob(id), getResume()]).then(([fetchedJob, fetchedResume]) => {
      setJob(fetchedJob);
      setResume(fetchedResume);
    });
  }, [id]);

  // Alive flag for the two poll loops below — flipped on unmount so a
  // navigate-away mid-generation stops the loop instead of polling forever
  // from a detached component.
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function pollUntilTerminal(runId: string) {
    while (aliveRef.current) {
      const run = await getTailor(runId);
      if (!aliveRef.current) return;
      setTailored(run);
      if (run.status === "completed") {
        setAccepted(run.diff.map(() => true));
        setStatus("review");
        return;
      }
      if (run.status === "failed") {
        setError("Tailoring failed — try generating again.");
        setStatus("error");
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function pollCorrelateUntilTerminal(reportId: string) {
    while (aliveRef.current) {
      const run = await getCorrelate(reportId);
      if (!aliveRef.current) return;
      if (run.status === "completed") {
        setReport(run);
        setStatus("report");
        return;
      }
      if (run.status === "failed") {
        setError("Analysis failed — try again.");
        setStatus("error");
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function onAnalyze() {
    if (!job) return;
    setStatus("correlating");
    setError(undefined);
    setNeedsScoreMessage(undefined);
    try {
      const started = await startCorrelate({ jobId: job.id });
      await pollCorrelateUntilTerminal(started.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_CREDITS") {
        const d = err.details as { feature: string; required: number; balance: number };
        showDenial(d);
      }
      if (err instanceof ApiError && err.code === "CONFLICT" && (err.details as { reason?: string } | undefined)?.reason === "no-jdfacts") {
        setNeedsScoreMessage(err.message);
        setStatus("needs-score");
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't analyze fit.");
      setStatus("error");
    }
  }

  async function onRewrite() {
    if (!job || !report) return;
    setStatus("rewriting");
    setError(undefined);
    try {
      const draft = await startTailor({ jobId: job.id, reportId: report.id });
      setTailored(draft);
      await pollUntilTerminal(draft.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_CREDITS") {
        const d = err.details as { feature: string; required: number; balance: number };
        showDenial(d);
      }
      setError(err instanceof Error ? err.message : "Couldn't start rewriting.");
      setStatus("error");
    }
  }

  function onToggle(index: number, accept: boolean) {
    setAccepted((prev) => prev.map((a, i) => (i === index ? accept : a)));
  }

  async function onSave(tailoredId: string, acceptedIndices: number[]) {
    try {
      const saved = await finalizeTailor(tailoredId, acceptedIndices);
      setTailored(saved);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your tailored résumé.");
      setStatus("error");
    }
  }

  async function onExport(acceptedIndices: number[]) {
    if (!tailored) return;
    setStatus("exporting");
    try {
      await finalizeTailor(tailored.id, acceptedIndices);
      window.open(tailorPdfUrl(tailored.id), "_blank", "noopener");
      setStatus("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export your tailored résumé.");
      setStatus("error");
    }
  }

  if (!job || !resume) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>
          Tailor résumé · {job.role} at {job.company}
        </span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <TailorResume
          job={job}
          resume={resume}
          tailored={tailored}
          report={report}
          status={status}
          error={error}
          needsScoreMessage={needsScoreMessage}
          accepted={accepted}
          onToggle={onToggle}
          onAnalyze={onAnalyze}
          onRewrite={onRewrite}
          onSave={onSave}
          onExport={onExport}
          onScoreJob={() => router.push(`/jobs/${id}`)}
        />
      </div>
    </div>
  );
}
