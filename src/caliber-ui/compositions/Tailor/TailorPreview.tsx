"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import type { Resume, TailoredResume } from "../../../types";

export type GeneratedResume = NonNullable<TailoredResume["resume"]>;

export interface TailorPreviewProps {
  resume: Resume;
  tailoredResume: GeneratedResume;
  diff: TailoredResume["diff"];
  accepted: boolean[];
}

// Section-level merge: for each named section in the diff, use the tailored
// value when its change is accepted, the original otherwise. Diff entries
// carry only the changed fragment (`before`/`after`), not a full-document
// patch, so the preview swaps whole sections rather than doing text surgery —
// a "paper preview of accepted-only state" (§3) without inventing a generic
// diff-apply engine the contract doesn't specify.
function sectionValue<T>(diff: TailoredResume["diff"], accepted: boolean[], section: string, base: T, tailored: T): T {
  const idx = diff.findIndex((d) => d.section === section);
  if (idx === -1) return base;
  return accepted[idx] ? tailored : base;
}

function experienceDiffIndex(diff: TailoredResume["diff"], company: string): number {
  return diff.findIndex((d) => {
    if (!d.section.startsWith("Experience · ")) return false;
    const tag = d.section.slice("Experience · ".length).trim();
    return company.includes(tag);
  });
}

export function TailorPreview({ resume, tailoredResume, diff, accepted }: TailorPreviewProps) {
  const headline = sectionValue(diff, accepted, "Headline", resume.headline, tailoredResume.headline);
  const summary = sectionValue(diff, accepted, "Summary", resume.summary, tailoredResume.summary);
  const skills = sectionValue(diff, accepted, "Skills", resume.skills, tailoredResume.skills);
  const experience = resume.experience.map((entry) => {
    const idx = experienceDiffIndex(diff, entry.company);
    const tailoredEntry = tailoredResume.experience.find((e) => e.company === entry.company) ?? entry;
    return idx !== -1 && accepted[idx] ? tailoredEntry : entry;
  });

  return (
    <Card padding="lg" radius="md" style={{ background: "var(--surface)", maxWidth: 640 }}>
      <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>{headline}</div>
      <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{resume.location}</div>
      <div style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 14 }}>{summary}</div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        {experience.map((exp, i) => (
          <div key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ font: "600 15px/1.3 var(--font-body)", color: "var(--text-strong)" }}>
                {exp.title} · {exp.company}
              </span>
              <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{exp.dates}</span>
            </div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
              {exp.bullets.map((b, j) => (
                <li key={j} style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {skills.map((s) => (
          <span
            key={s}
            style={{
              font: "500 12.5px/1 var(--font-body)",
              color: "var(--text-body)",
              background: "var(--surface-sunken)",
              padding: "6px 10px",
              borderRadius: "var(--radius-pill, 999px)",
            }}
          >
            {s}
          </span>
        ))}
      </div>
    </Card>
  );
}
