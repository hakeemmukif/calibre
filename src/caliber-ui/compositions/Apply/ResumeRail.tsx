"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import { Tag } from "../../components/Tag";
import type { Resume } from "../../../types";
import type { GroundingItem } from "./GroundingChips";

export interface ResumeRailProps {
  resume: Resume;
  open: boolean;
  onToggle(): void;
  /** The citation a grounding chip was just clicked for — scrolls/highlights its source. */
  active?: GroundingItem;
}

function Section({
  title,
  active,
  children,
}: {
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      style={{
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--accent-soft)" : "transparent",
        border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
        transition: "background var(--transition), border-color var(--transition)",
      }}
    >
      <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 4 }}>{title}</div>
      <div style={{ font: "var(--type-caption)", color: "var(--text-body)" }}>{children}</div>
    </div>
  );
}

// ResumeRail — the collapsible résumé side-rail F4 scrolls to when a
// GroundingChip is clicked. Sections mirror Resume's own shape (headline,
// summary, skills, experience); the section matching `active.source` (and,
// for `experience`, the specific bullet containing `active.quote`) is
// highlighted.
export function ResumeRail({ resume, open, onToggle, active }: ResumeRailProps) {
  return (
    <Card
      padding="none"
      style={{
        width: open ? 280 : 44,
        flex: "none",
        overflow: "hidden",
        transition: "width var(--transition)",
        alignSelf: "flex-start",
        position: "sticky",
        top: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: open ? "space-between" : "center", padding: 8 }}>
        {open && <span style={{ font: "var(--type-label)", color: "var(--text-strong)", paddingLeft: 6 }}>Résumé</span>}
        <IconButton
          icon={open ? "chevron-up" : "chevron-down"}
          label={open ? "Collapse résumé rail" : "Expand résumé rail"}
          onClick={onToggle}
          style={{ transform: open ? "rotate(90deg)" : "rotate(-90deg)" }}
        />
      </div>

      {open && (
        <div style={{ padding: "0 10px 12px", display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
          <Section title="Headline" active={active?.source === "headline"}>
            {resume.headline}
          </Section>
          {resume.summary && (
            <Section title="Summary" active={active?.source === "summary"}>
              {resume.summary}
            </Section>
          )}
          <Section title="Skills" active={active?.source === "skills"}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {resume.skills.map((s) => (
                <Tag key={s} tone="neutral">{s}</Tag>
              ))}
            </div>
          </Section>
          <Section title="Experience" active={active?.source === "experience"}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {resume.experience.map((exp, i) => (
                <div key={i}>
                  <div style={{ font: "600 12.5px/1.3 var(--font-body)", color: "var(--text-strong)" }}>
                    {exp.company} · {exp.dates}
                  </div>
                  <ul style={{ margin: "3px 0 0", paddingLeft: 16 }}>
                    {exp.bullets.map((b, j) => {
                      const isActive = active?.source === "experience" && (b.includes(active.quote) || active.quote.includes(b));
                      return (
                        <li key={j} style={{ marginBottom: 2, color: isActive ? "var(--accent-ink)" : "var(--text-body)", fontWeight: isActive ? 600 : 400 }}>
                          {b}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}
    </Card>
  );
}
