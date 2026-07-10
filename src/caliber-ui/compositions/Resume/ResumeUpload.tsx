"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export type ResumeUploadStatus = "idle" | "uploading" | "parsing" | "error" | "done";

export interface ResumeUploadProps {
  onFile(f: File): void;
  status: ResumeUploadStatus;
  progress?: number;
  error?: string;
}

// ResumeUpload — F1 ingest dropzone. `status` is controlled by the parent
// (mirrors the POST /api/resume lifecycle); drag-over is transient local UI
// state layered on top of `idle`. A "Paste text instead" fallback wraps the
// pasted text into a File so it still funnels through the single `onFile`
// callback — no second upload path is invented.
export function ResumeUpload({ onFile, status, progress, error }: ResumeUploadProps) {
  const [dragOver, setDragOver] = React.useState(false);
  const [pasting, setPasting] = React.useState(false);
  const [pastedText, setPastedText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const busy = status === "uploading" || status === "parsing";

  function pick() {
    if (busy) return;
    inputRef.current?.click();
  }

  function handleFiles(files: FileList | null) {
    const f = files?.[0];
    if (f) onFile(f);
  }

  function usePastedText() {
    if (pastedText.trim().length < 100) return;
    onFile(new File([pastedText], "resume.txt", { type: "text/plain" }));
    setPasting(false);
  }

  return (
    <Card
      padding="lg"
      radius="lg"
      style={{
        border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--border-strong)"}`,
        background: dragOver ? "var(--accent-soft)" : "var(--surface)",
        textAlign: "center",
        transition: "border-color var(--transition), background var(--transition)",
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!busy) handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {status === "idle" && !pasting && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "18px 8px" }}>
          <Icon name="upload" size={28} style={{ color: dragOver ? "var(--accent)" : "var(--text-muted)" }} />
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>
            Drop your résumé here
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>PDF or DOCX, up to 10 MB</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <Button variant="primary" iconLeft="upload" onClick={pick}>Browse files</Button>
            <Button variant="ghost" iconLeft="file-text" onClick={() => setPasting(true)}>Paste text instead</Button>
          </div>
        </div>
      )}

      {status === "idle" && pasting && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "6px 4px", textAlign: "left" }}>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>Paste your résumé text</div>
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste the plain text of your résumé (min. 100 characters)…"
            rows={8}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              font: "var(--type-body)",
              color: "var(--text-strong)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm)",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setPasting(false)}>Cancel</Button>
            <Button variant="primary" disabled={pastedText.trim().length < 100} onClick={usePastedText}>
              Use this text
            </Button>
          </div>
        </div>
      )}

      {busy && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "24px 8px" }}>
          <Icon name="refresh-cw" size={26} style={{ color: "var(--accent)", animation: "caliber-spin 1s linear infinite" }} />
          <style>{`@keyframes caliber-spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
            {status === "uploading" ? "Uploading résumé…" : "Parsing résumé…"}
          </div>
          {typeof progress === "number" && (
            <div style={{ width: "100%", maxWidth: 220, height: 6, borderRadius: "var(--radius-bar)", background: "var(--surface-sunken)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, progress))}%`, background: "var(--gradient-score)", transition: "width var(--transition)" }} />
            </div>
          )}
        </div>
      )}

      {status === "error" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 8px" }}>
          <Icon name="triangle-alert" size={26} style={{ color: "var(--danger-ink)" }} />
          <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
            {error || "Couldn't parse that file."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" iconLeft="refresh-cw" onClick={pick}>Try again</Button>
            <Button variant="ghost" iconLeft="file-text" onClick={() => setPasting(true)}>Paste text instead</Button>
          </div>
          {pasting && (
            <div style={{ width: "100%", textAlign: "left", marginTop: 4 }}>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste the plain text of your résumé (min. 100 characters)…"
                rows={6}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  font: "var(--type-body)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <Button variant="primary" disabled={pastedText.trim().length < 100} onClick={usePastedText}>
                  Use this text
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {status === "done" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "22px 8px" }}>
          <Icon name="circle-check" size={26} style={{ color: "var(--fit-strong)" }} />
          <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>Résumé parsed and saved.</div>
        </div>
      )}
    </Card>
  );
}
