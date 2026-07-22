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
// value when ANY of that section's changes is accepted, the original
// otherwise. Diff entries carry only the changed fragment (`before`/`after`),
// not a full-document patch, so the preview swaps whole sections rather than
// doing text surgery — a "paper preview of accepted-only state" (§3) without
// inventing a generic diff-apply engine the contract doesn't specify.
// Accept/reject is keyed by diff INDEX, not by section name: two diff
// entries can legitimately target the same section, and looking up "the"
// index for a section (rather than every index) would silently drop one of
// them.
function sectionIndices(diff: TailoredResume["diff"], section: string): number[] {
  return diff.reduce<number[]>((acc, d, i) => (d.section === section ? [...acc, i] : acc), []);
}

function sectionValue<T>(diff: TailoredResume["diff"], accepted: boolean[], section: string, base: T, tailored: T): T {
  const indices = sectionIndices(diff, section);
  const anyAccepted = indices.some((i) => accepted[i]);
  return anyAccepted ? tailored : base;
}

function experienceDiffIndices(diff: TailoredResume["diff"], company: string): number[] {
  return diff.reduce<number[]>((acc, d, i) => {
    if (!d.section.startsWith("Experience · ")) return acc;
    const tag = d.section.slice("Experience · ".length).trim();
    return company.includes(tag) ? [...acc, i] : acc;
  }, []);
}

export function TailorPreview({ resume, tailoredResume, diff, accepted }: TailorPreviewProps) {
  const headline = sectionValue(diff, accepted, "Headline", resume.headline ?? "", tailoredResume.headline);
  const summary = sectionValue(diff, accepted, "Summary", resume.summary, tailoredResume.summary);
  const skills = sectionValue(diff, accepted, "Skills", resume.skills, tailoredResume.skills);
  const experience = resume.experience.map((entry) => {
    const indices = experienceDiffIndices(diff, entry.company);
    const anyAccepted = indices.some((i) => accepted[i]);
    const tailoredEntry = tailoredResume.experience.find((e) => e.company === entry.company) ?? entry;
    return anyAccepted ? tailoredEntry : entry;
  });

  return (
    <Card padding="lg" radius="md" style={{ background: "var(--surface)", maxWidth: 640 }}>
      <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>{headline}</div>
      {resume.location && (<div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{resume.location}</div>)}
      {summary && <div style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 14 }}>{summary}</div>}

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
