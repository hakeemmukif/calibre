"use client";
// F1 — résumé upload/view, wired to the real backend
// (component-inventory.md ResumeUpload/ResumeView; api-contract.md §3
// "POST/GET /api/resume"). Upload-triggered dual-persona search
// (task-B10-brief.md): once a résumé is confirmed (ResumeUpload's `done`
// state — the kit has no separate confirm step), fire TWO single-persona
// POST /api/search calls (remote + local) — never a "both" persona on the
// frozen contract.
import * as React from "react";
import { useRouter } from "next/navigation";
import { ResumeUpload, type ResumeUploadStatus } from "@/caliber-ui/compositions/Resume/ResumeUpload";
import { ResumeView } from "@/caliber-ui/compositions/Resume/ResumeView";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getResume, uploadResume } from "@/features/resume/client";
import { startSearch } from "@/features/search/client";
import type { Resume } from "@/types";

export default function ResumePage() {
  const router = useRouter();
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<ResumeUploadStatus>("idle");
  const [error, setError] = React.useState<string | undefined>();
  const [searchError, setSearchError] = React.useState<string | undefined>();

  async function startSearches() {
    setSearchError(undefined);
    const results = await Promise.allSettled([startSearch({ persona: "remote" }), startSearch({ persona: "local" })]);

    // Both failed → stay on the page and surface a retry. If at least one
    // started, navigate to /scans — both runs are visible in the list (D7),
    // which is where a scan now lives.
    if (!results.some((r) => r.status === "fulfilled")) {
      const reason = results[0].status === "rejected" && results[0].reason instanceof Error ? results[0].reason.message : "unknown error";
      setSearchError(`Search failed to start — retry. (${reason})`);
      return;
    }

    router.push("/scans");
  }

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
      void startSearches();
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
          <>
            {searchError && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--danger-soft)",
                  color: "var(--danger-ink)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="triangle-alert" size={16} />
                  <span style={{ font: "var(--type-body)" }}>{searchError}</span>
                </div>
                <Button variant="secondary" iconLeft="refresh-cw" onClick={() => void startSearches()}>
                  Retry
                </Button>
              </div>
            )}
            <ResumeView
              resume={resume}
              onReupload={() => {
                setResume(null);
                setStatus("idle");
                setSearchError(undefined);
              }}
            />
          </>
        ) : (
          <ResumeUpload status={status} onFile={handleFile} error={error} />
        )}
      </div>
    </div>
  );
}
