"use client";
// F1 — résumé upload/view, wired to the real backend
// (component-inventory.md ResumeUpload/ResumeView; api-contract.md §3
// "POST/GET /api/resume"). Upload-triggered dual-persona search
// (task-B10-brief.md): once a résumé is confirmed (ResumeUpload's `done`
// state — the kit has no separate confirm step), fire TWO single-persona
// POST /api/search calls (remote + local) — never a "both" persona on the
// frozen contract.
import * as React from "react";
import { ResumeUpload, type ResumeUploadStatus } from "@/caliber-ui/compositions/Resume/ResumeUpload";
import { ResumeView } from "@/caliber-ui/compositions/Resume/ResumeView";
import { getResume, uploadResume } from "@/features/resume/client";
import { startSearch } from "@/features/search/client";
import type { Resume } from "@/types";

export default function ResumePage() {
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<ResumeUploadStatus>("idle");
  const [error, setError] = React.useState<string | undefined>();

  React.useEffect(() => {
    void getResume().then((r) => {
      setResume(r);
      setLoaded(true);
    });
  }, []);

  async function handleFile(file: File) {
    setStatus("uploading");
    setError(undefined);
    try {
      // ResumeUpload's "paste text instead" path wraps the pasted text into a
      // text/plain File (its only upload path) — route it to the JSON
      // `{text}` body; anything else (PDF/DOCX) goes multipart.
      const uploaded =
        file.type === "text/plain" ? await uploadResume({ text: await file.text() }) : await uploadResume({ file });
      setStatus("done");
      setResume(uploaded);
      void Promise.allSettled([startSearch({ persona: "remote" }), startSearch({ persona: "local" })]);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't parse that file.");
    }
  }

  if (!loaded) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {resume ? (
          <ResumeView
            resume={resume}
            onReupload={() => {
              setResume(null);
              setStatus("idle");
            }}
          />
        ) : (
          <ResumeUpload status={status} onFile={handleFile} error={error} />
        )}
      </div>
    </div>
  );
}
