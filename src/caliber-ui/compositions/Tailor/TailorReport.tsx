"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Tag, type TagTone } from "../../components/Tag";
import { FitBar } from "../../components/FitBar";
import { SignalBar } from "./SignalBar";
import type { CorrelationReport, CorrelationRow } from "../../../types";

const STATUS_TONE: Record<CorrelationRow["status"], TagTone> = { met: "good", buried: "warn", gap: "neutral" };
const GROUPS: { status: CorrelationRow["status"]; heading: string }[] = [
  { status: "buried", heading: "Buried — surface these" },
  { status: "met", heading: "Met — already strong" },
  { status: "gap", heading: "Gap — won't fabricate" },
];

export interface TailorReportProps {
  report: CorrelationReport;
  rewriting: boolean;
  onRewrite(): void;
}

// TailorReport — the "measure" step of F6 phase 2 (layout A): two separate
// signal readouts (semantic coverage, ATS keyword presence — never fused
// into one percentage) followed by requirement rows grouped Buried → Met →
// Gap, and a single "Rewrite to close these" CTA.
export function TailorReport({ report, rewriting, onRewrite }: TailorReportProps) {
  const { semantic, ats, rows } = report;
  const covered = semantic.met + semantic.buried;
  const atsPct = ats.total === 0 ? 0 : Math.round((ats.present / ats.total) * 100);
  const noCandidates = semantic.met + semantic.buried === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginBottom: 4 }}>Requirements covered</div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8 }}>
            {covered} of {semantic.total}{" "}
            <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
              · {semantic.met} met · {semantic.buried} buried · {semantic.gap} gap
            </span>
          </div>
          <SignalBar
            segments={[
              { value: semantic.met, color: "var(--fit-strong)" },
              { value: semantic.buried, color: "var(--fit-mid)" },
              { value: semantic.gap, color: "var(--fit-weak)" },
            ]}
          />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <FitBar
            label="ATS keywords present"
            value={atsPct}
            display={`${ats.present} of ${ats.total}`}
            tone={atsPct >= 70 ? "good" : atsPct >= 40 ? "warn" : "weak"}
          />
          {ats.missing.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {ats.missing.map((t) => (
                <span
                  key={t}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 9px",
                    borderRadius: "var(--radius-pill, 999px)",
                    font: "500 12px/1 var(--font-body)",
                    color: "var(--text-muted)",
                    background: "var(--surface-sunken)",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {GROUPS.map(({ status, heading }) => {
        const groupRows = rows.filter((r) => r.status === status);
        if (groupRows.length === 0) return null;
        return (
          <div key={status} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ font: "var(--type-eyebrow)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)", color: "var(--text-muted)" }}>
              {heading} · {groupRows.length}
            </div>
            {groupRows.map((r, i) => (
              <div key={`${r.requirement}-${i}`} style={{ borderTop: "1px solid var(--border-faint)", paddingTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag tone={STATUS_TONE[r.status]}>{r.status}</Tag>
                  <span style={{ font: "600 14px/1.4 var(--font-body)", color: "var(--text-strong)" }}>{r.requirement}</span>
                  <span style={{ font: "var(--type-caption)", color: "var(--text-faint)", textTransform: "uppercase" }}>{r.kind}</span>
                  <span style={{ marginLeft: "auto", font: "var(--type-caption)", color: r.atsPresent ? "var(--fit-strong)" : "var(--text-faint)" }}>
                    ATS {r.atsPresent ? "✓" : "✗"}
                  </span>
                </div>
                {r.evidence && (
                  <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontStyle: "italic", borderLeft: "2px solid var(--border)", paddingLeft: 10, marginTop: 5 }}>
                    "{r.evidence}"
                  </div>
                )}
                <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>
                  {r.reason}
                  {r.note && <span> · {r.note}</span>}
                </div>
              </div>
            ))}
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--border-faint)", paddingTop: 14 }}>
        <Button variant="soft-accent" iconLeft="sparkles" onClick={onRewrite} disabled={rewriting || noCandidates}>
          {rewriting ? "Rewriting…" : "Rewrite to close these"}
        </Button>
        <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
          {noCandidates
            ? "No buried or met requirements to surface — nothing to rewrite honestly."
            : `Rewrites the ${semantic.buried} buried + ${semantic.met} met rows. Gaps stay untouched.`}
        </span>
      </div>
    </div>
  );
}
