"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Tag } from "../../components/Tag";
import { Tabs } from "../../components/Tabs";
import { ScoreBadge } from "../../components/ScoreBadge";
import type { Resume } from "../../../types";

export interface ResumeViewProps {
  resume: Resume;
  onTailor?(): void;
  onReupload(): void;
}

// "3d ago" — derived client-side from Resume.updatedAt (§5: the wire form
// carries the ISO timestamp, the UI owns relative formatting).
function agoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

// ResumeView — the parsed structured résumé (F1). Card sections for
// summary/experience, Tag for skills, ScoreBadge for atsScore, and a
// Tabs switch between the structured Overview and the raw parsed text
// (rawText — the provenance F4/F6 ground answers against).
export function ResumeView({ resume, onTailor, onReupload }: ResumeViewProps) {
  const [tab, setTab] = React.useState<"overview" | "raw">("overview");
  const atsTone = resume.atsScore >= 70 ? "strong" : resume.atsScore >= 45 ? "mid" : "weak";

  return (
    <Card padding="lg" style={{ maxWidth: 760 }}>
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <ScoreBadge score={resume.atsScore} outOf={100} size="lg" tone={atsTone} label="ATS" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>{resume.headline}</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 3 }}>
            {resume.location} · Updated {agoLabel(resume.updatedAt)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          {onTailor && (
            <Button variant="soft-accent" iconLeft="sparkles" onClick={onTailor}>Tailor</Button>
          )}
          <Button variant="secondary" iconLeft="upload" onClick={onReupload}>Re-upload</Button>
        </div>
      </div>

      <Tabs
        style={{ marginTop: 18 }}
        tabs={[{ id: "overview", label: "Overview" }, { id: "raw", label: "Raw text" }]}
        activeId={tab}
        onSelect={(id) => setTab(id as "overview" | "raw")}
      />

      {tab === "overview" && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 20 }}>
          <section>
            <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Summary</div>
            <p style={{ font: "var(--type-body)", color: "var(--text-body)", margin: 0 }}>{resume.summary}</p>
          </section>

          <section>
            <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 10 }}>Experience</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {resume.experience.map((exp, i) => (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <span style={{ font: "600 15px/1.3 var(--font-body)", color: "var(--text-strong)" }}>
                      {exp.title} · {exp.company}
                    </span>
                    <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", flex: "none" }}>{exp.dates}</span>
                  </div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--text-body)", font: "var(--type-body)" }}>
                    {exp.bullets.map((b, j) => (
                      <li key={j} style={{ marginBottom: 3 }}>{b}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 8 }}>Skills</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {resume.skills.map((s) => (
                <Tag key={s} tone="neutral">{s}</Tag>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "raw" && (
        <pre
          style={{
            marginTop: 16,
            padding: 14,
            background: "var(--surface-sunken)",
            borderRadius: "var(--radius-sm)",
            font: "400 13px/1.6 ui-monospace, monospace",
            color: "var(--text-body)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {resume.rawText}
        </pre>
      )}
    </Card>
  );
}
