"use client";
// F6 — diff-review résumé tailoring, wired to the real backend
// (component-inventory.md §3 TailorResume; api-contract.md §3 "POST
// /api/tailor", "GET /api/tailor/:id", "POST /api/tailor/:id/finalize",
// "GET /api/tailor/:id/pdf"). TailorResume is purely presentational — this
// page owns the whole state machine (configuring -> generating -> review ->
// saved/exporting), polling `GET /api/tailor/:id` until the run terminates.
import * as React from "react";
import { useParams } from "next/navigation";
import { TailorResume, type TailorUiState } from "@/caliber-ui/compositions/Tailor/TailorResume";
import { finalizeTailor, getTailor, startTailor, tailorPdfUrl } from "@/features/tailor/client";
import { getJob } from "@/features/feed/client";
import { getResume } from "@/features/resume/client";
import type { Job, Resume, TailoredResume } from "@/types";

const POLL_INTERVAL_MS = 400;

export default function TailorPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = React.useState<Job | null>(null);
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [tailored, setTailored] = React.useState<TailoredResume | undefined>();
  const [status, setStatus] = React.useState<TailorUiState>("configuring");
  const [error, setError] = React.useState<string | undefined>();
  const [accepted, setAccepted] = React.useState<boolean[]>([]);

  React.useEffect(() => {
    void Promise.all([getJob(id), getResume()]).then(([fetchedJob, fetchedResume]) => {
      setJob(fetchedJob);
      setResume(fetchedResume);
    });
  }, [id]);

  async function pollUntilTerminal(runId: string) {
    while (true) {
      const run = await getTailor(runId);
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

  async function onGenerate() {
    if (!job) return;
    setStatus("generating");
    setError(undefined);
    try {
      const draft = await startTailor({ jobId: job.id });
      setTailored(draft);
      await pollUntilTerminal(draft.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start tailoring.");
      setStatus("error");
    }
  }

  function onToggle(index: number, accept: boolean) {
    setAccepted((prev) => prev.map((a, i) => (i === index ? accept : a)));
  }

  async function onSave(tailoredId: string, acceptedIndices: number[]) {
    const saved = await finalizeTailor(tailoredId, acceptedIndices);
    setTailored(saved);
    setStatus("saved");
  }

  async function onExport(acceptedIndices: number[]) {
    if (!tailored) return;
    setStatus("exporting");
    await finalizeTailor(tailored.id, acceptedIndices);
    window.open(tailorPdfUrl(tailored.id), "_blank", "noopener");
    setStatus("review");
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
          status={status}
          error={error}
          accepted={accepted}
          onToggle={onToggle}
          onGenerate={onGenerate}
          onSave={onSave}
          onExport={onExport}
        />
      </div>
    </div>
  );
}
