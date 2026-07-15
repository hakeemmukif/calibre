"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Tag } from "../../components/Tag";
import { Tabs } from "../../components/Tabs";
import { ScoreBadge } from "../../components/ScoreBadge";
import { Icon } from "../../components/Icon";
import { agoLabel } from "../../lib/format";
import type { Resume } from "../../../types";

export interface ResumeViewProps {
  resume: Resume;
  onTailor?(): void;
  onReupload(): void;
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

      {resume.extractionPath === "vision" && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--fit-mid-soft)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <Icon name="circle-help" size={18} style={{ color: "var(--fit-mid)", flex: "none" }} />
          <span style={{ font: "var(--type-caption)", color: "var(--text-strong)" }}>
            We read this résumé from an image — please double-check the details.
          </span>
        </div>
      )}

      <Tabs
        style={{ marginTop: 18 }}
        tabs={[{ id: "overview", label: "Overview" }, { id: "raw", label: "Raw text" }]}
        activeId={tab}
        onSelect={(id) => setTab(id as "overview" | "raw")}
      />

      {tab === "overview" && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 20 }}>
          {resume.summary && (
            <section>
              <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Summary</div>
              <p style={{ font: "var(--type-body)", color: "var(--text-body)", margin: 0 }}>{resume.summary}</p>
            </section>
          )}

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

          {resume.projects.length > 0 && (
            <section>
              <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 10 }}>Projects</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {resume.projects.map((p, i) => (
                  <div key={i}>
                    <span style={{ font: "600 15px/1.3 var(--font-body)", color: "var(--text-strong)" }}>
                      {p.name}
                      {p.url && (
                        <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontWeight: 400 }}> · {p.url}</span>
                      )}
                    </span>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--text-body)", font: "var(--type-body)" }}>
                      {p.bullets.map((b, j) => (
                        <li key={j} style={{ marginBottom: 3 }}>{b}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {resume.certifications.length > 0 && (
            <section>
              <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 8 }}>Certifications</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {resume.certifications.map((c, i) => (
                  <Tag key={i} tone="neutral">
                    {c.name}
                    {c.issuer && ` · ${c.issuer}`}
                    {c.year && ` (${c.year})`}
                  </Tag>
                ))}
              </div>
            </section>
          )}

          {resume.languages.length > 0 && (
            <section>
              <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 8 }}>Languages</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {resume.languages.map((l, i) => (
                  <Tag key={i} tone="neutral">
                    {l.language}
                    {l.proficiency && ` (${l.proficiency})`}
                  </Tag>
                ))}
              </div>
            </section>
          )}
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
