"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import type { TailoredResume } from "../../../types";

export type TailorDiffEntry = TailoredResume["diff"][number];

export interface ChangeCardProps {
  change: TailorDiffEntry;
  accepted: boolean;
  onToggle(accept: boolean): void;
}

const OP_LABEL: Record<TailorDiffEntry["op"], string> = {
  add: "Added",
  remove: "Removed",
  modify: "Rewrote",
};

// ChangeCard — one line of the F6 diff review (§3): before/after text, a
// one-line rationale (`reason`), and an accept/reject toggle. The rejected
// state dims the card so accepted vs. rejected reads at a glance down the list.
export function ChangeCard({ change, accepted, onToggle }: ChangeCardProps) {
  return (
    <Card padding="sm" style={{ opacity: accepted ? 1 : 0.6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ font: "var(--type-eyebrow)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)", color: "var(--text-faint)" }}>
            {change.section}
          </span>
          <span
            style={{
              font: "600 11px/1 var(--font-body)",
              color: "var(--text-muted)",
              background: "var(--surface-sunken)",
              padding: "3px 8px",
              borderRadius: "var(--radius-pill, 999px)",
            }}
          >
            {OP_LABEL[change.op]}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Chip variant="filter" selected={accepted} iconLeft="check" onClick={() => onToggle(true)}>
            Accept
          </Chip>
          <Chip variant="filter" selected={!accepted} iconLeft="x" onClick={() => onToggle(false)}>
            Reject
          </Chip>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        {change.before && (
          <div style={{ font: "var(--type-body)", color: "var(--text-muted)", textDecoration: change.op !== "add" ? "line-through" : "none" }}>
            {change.before}
          </div>
        )}
        {change.before && change.after && (
          <Icon name="arrow-right" size={14} style={{ color: "var(--text-faint)", transform: "rotate(90deg)" }} />
        )}
        {change.after && (
          <div style={{ font: "600 15px/1.5 var(--font-body)", color: "var(--text-strong)" }}>{change.after}</div>
        )}
      </div>

      <div style={{ marginTop: 8, font: "var(--type-caption)", color: "var(--text-muted)", fontStyle: "italic" }}>
        {change.reason}
      </div>
    </Card>
  );
}
