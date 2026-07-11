"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Tabs } from "../../components/Tabs";
import { FitBar } from "../../components/FitBar";
import { Tag } from "../../components/Tag";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { AppliedButton } from "../Apply/AppliedButton";
import { LegitimacyTag } from "../../lib/legitimacy";
import { agoLabel, toFitBarTone } from "../../lib/format";
import type { Job, Application } from "../../../types";

export interface JobDetailProps {
  job: Job;
  applied?: Application;
  onApply(): void;
  onTailor(): void;
  onAnswerQuestions(): void;
  /** Not in the frozen component-inventory signature; added so AppliedButton
   * (a composed primitive of JobDetail per §1) has a real handler to call —
   * optional, additive, mirrors JobFeed's onRetry precedent. */
  onMarkApplied(): Promise<void>;
  /** Optional, additive (Task 9) — mirrors the onMarkApplied precedent above.
   * Renders a "Re-evaluate" action only when provided. */
  onEvaluate?: () => void;
  evaluateStatus?: "idle" | "evaluating" | "error";
}

// JobDetail — the full posting view (F3/F4/F6 launcher): Card + Tabs
// (Fit·Legitimacy·Breakdown) + FitBar[] + Tag + Apply Button (primary,
// external-link icon) + AppliedButton. Scam-tier demotes Apply to a
// secondary action behind a warning banner. Consumes `Job` alone — there is
// no separate detail entity in MVP (api-contract.md §1); the Fit/
// Legitimacy/Breakdown tabs read `job.fit`/`job.legitimacy`/`job.breakdown`
// directly.
export function JobDetail({
  job,
  applied,
  onApply,
  onTailor,
  onAnswerQuestions,
  onMarkApplied,
  onEvaluate,
  evaluateStatus = "idle",
}: JobDetailProps) {
  const [tab, setTab] = React.useState<"fit" | "legitimacy" | "breakdown">("fit");
  const isScam = job.legitimacy.tier === "scam";

  return (
    <Card padding="lg" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>{job.role}</span>
            <LegitimacyTag legitimacy={job.legitimacy} />
            {job.isNew && <Tag tone="neutral">New</Tag>}
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>
            {job.company} · {job.meta}
          </div>
        </div>
        <div style={{ font: "700 20px/1 var(--font-display)", color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>
          {job.score.toFixed(1)}<span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>/5 fit</span>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {job.tags.map((t) => (
          <Tag key={t.label} tone={t.tone}>{t.label}</Tag>
        ))}
      </div>

      <p style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 12 }}>{job.verdict}</p>

      {isScam && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            background: "var(--danger-soft)",
            color: "var(--danger-ink)",
          }}
        >
          <Icon name="triangle-alert" size={16} />
          <span style={{ font: "var(--type-body)" }}>
            This posting matches a known scam pattern. Applying is not recommended — review the Legitimacy tab before proceeding.
          </span>
        </div>
      )}

      <Tabs
        style={{ marginTop: 18 }}
        tabs={[
          { id: "fit", label: "Fit" },
          { id: "legitimacy", label: "Legitimacy" },
          { id: "breakdown", label: "Breakdown" },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as "fit" | "legitimacy" | "breakdown")}
      />

      {tab === "fit" && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {job.fit.map((f) => (
            <div key={f.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, font: "var(--type-body)" }}>
              <span style={{ color: "var(--text-muted)" }}>{f.k}</span>
              <span style={{ color: "var(--text-strong)", textAlign: "right" }}>{f.v}</span>
            </div>
          ))}
          {job.gaps.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>Gaps</div>
              {job.gaps.map((g) => (
                <div key={g.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Tag tone={g.tone === "warn" ? "warn" : "good"}>{g.k}</Tag>
                  <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{g.v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "legitimacy" && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LegitimacyTag legitimacy={job.legitimacy} />
          </div>
          <p style={{ font: "var(--type-body)", color: "var(--text-body)", margin: 0 }}>{job.legitimacy.summary}</p>
          {typeof job.legitimacy.confidence === "number" && (
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
              Confidence: {Math.round(job.legitimacy.confidence * 100)}%
            </div>
          )}
        </div>
      )}

      {tab === "breakdown" && (
        <div style={{ marginTop: 16 }}>
          {job.breakdown.map((b) => (
            <FitBar key={b.label} label={b.label} value={b.value} display={b.display} tone={toFitBarTone(b.tone)} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
        <Button variant={isScam ? "secondary" : "primary"} iconRight="external-link" onClick={onApply}>
          {isScam ? "Open posting anyway" : "Apply"}
        </Button>
        <Button variant="soft-accent" iconLeft="sparkles" onClick={onTailor}>Tailor résumé</Button>
        {onEvaluate && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              variant="secondary"
              iconLeft={evaluateStatus === "evaluating" ? undefined : "refresh-cw"}
              disabled={evaluateStatus === "evaluating"}
              onClick={onEvaluate}
            >
              {evaluateStatus === "evaluating" ? "Re-evaluating…" : "Re-evaluate"}
            </Button>
            {evaluateStatus === "error" && (
              <span style={{ font: "var(--type-caption)", color: "var(--danger-ink)" }}>
                Couldn&apos;t re-evaluate — try again.
              </span>
            )}
          </div>
        )}
        <Button variant="secondary" iconLeft="file-text" onClick={onAnswerQuestions}>Answer questions</Button>
        <AppliedButton
          applied={!!applied}
          appliedAgo={applied ? agoLabel(applied.appliedAt) : undefined}
          onMarkApplied={onMarkApplied}
        />
      </div>
    </Card>
  );
}
