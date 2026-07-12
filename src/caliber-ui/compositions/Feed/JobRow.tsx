"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { ScoreBadge } from "../../components/ScoreBadge";
import { IconButton } from "../../components/IconButton";
import { NewBadge } from "./NewBadge";
import { EligibilityTag } from "../../lib/eligibility";
import { LegitimacyTag } from "../../lib/legitimacy";
import type { Job } from "../../../types";

export interface JobRowProps {
  job: Job;
  onOpen(): void;
  onSave(): void;
  onDismiss(): void;
}

// JobRow — the A·Signal-Pill row, the hero unit (§11.8): Card (hover lift) →
// ScoreBadge fit ring left · title + Tag legitimacy + NewBadge · meta/why ·
// Open/Save/Dismiss IconButtons.
export function JobRow({ job, onOpen, onSave, onDismiss }: JobRowProps) {
  const isGhost = job.ghost || job.legitimacy.tier === "ghost";
  const [focused, setFocused] = React.useState(false);

  function stop(e: React.MouseEvent, fn: () => void) {
    e.stopPropagation();
    fn();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <Card
      interactive
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        opacity: isGhost ? 0.72 : 1,
        ...(focused ? { boxShadow: "var(--shadow-focus)" } : {}),
      }}
    >
      <ScoreBadge score={job.score} size="md" tone={isGhost ? "ghost" : undefined} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              font: "var(--type-h3)",
              color: "var(--text-strong)",
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {job.role}
          </span>
          <LegitimacyTag legitimacy={job.legitimacy} />
          {job.eligibility.tier !== "local" && <EligibilityTag eligibility={job.eligibility} />}
          {job.isNew && <NewBadge />}
        </div>
        <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 3 }}>
          {job.company} · {job.meta}
        </div>
        <div style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 6 }}>{job.why}</div>
      </div>

      <div style={{ display: "flex", gap: 2, flex: "none" }}>
        <IconButton icon="arrow-right" label="Open" onClick={(e) => stop(e, onOpen)} />
        <IconButton icon="bookmark" label="Save" onClick={(e) => stop(e, onSave)} />
        <IconButton icon="x" label="Dismiss" onClick={(e) => stop(e, onDismiss)} />
      </div>
    </Card>
  );
}
