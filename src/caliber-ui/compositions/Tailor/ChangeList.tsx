"use client";
import * as React from "react";
import { ChangeCard } from "./ChangeCard";
import type { TailoredResume } from "../../../types";

export interface ChangeListProps {
  changes: TailoredResume["diff"];
  accepted: boolean[];
  onToggle(index: number, accept: boolean): void;
}

// ChangeList — the F6 diff review body (§3): ChangeCards grouped by section,
// in source order, each bound to its own accept/reject flag by index.
export function ChangeList({ changes, accepted, onToggle }: ChangeListProps) {
  const sections: string[] = [];
  for (const c of changes) if (!sections.includes(c.section)) sections.push(c.section);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {sections.map((section) => (
        <div key={section} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{section}</div>
          {changes.map((change, i) =>
            change.section === section ? (
              <ChangeCard key={i} change={change} accepted={accepted[i]} onToggle={(accept) => onToggle(i, accept)} />
            ) : null,
          )}
        </div>
      ))}
    </div>
  );
}
