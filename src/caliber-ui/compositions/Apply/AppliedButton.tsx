"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";

export interface AppliedButtonProps {
  applied: boolean;
  appliedAgo?: string;
  onMarkApplied(): Promise<void>;
}

// AppliedButton — F5 mark-applied. `applied` is the source of truth (the
// Application row itself); `confirming`/`error` are transient local UI state
// around the in-flight POST /api/applications call.
export function AppliedButton({ applied, appliedAgo, onMarkApplied }: AppliedButtonProps) {
  const [phase, setPhase] = React.useState<"idle" | "confirming" | "error">("idle");

  React.useEffect(() => {
    if (applied) setPhase("idle");
  }, [applied]);

  async function handleClick() {
    setPhase("confirming");
    try {
      await onMarkApplied();
      setPhase("idle");
    } catch {
      setPhase("error");
    }
  }

  if (applied) {
    return (
      <Chip variant="filter" selected disabled style={{ cursor: "default" }}>
        <Icon name="check" size={13} strokeWidth={2.4} />
        {appliedAgo ? `Applied · ${appliedAgo}` : "Applied"}
      </Chip>
    );
  }

  if (phase === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ font: "var(--type-caption)", color: "var(--danger-ink)" }}>Couldn't save — try again.</span>
        <Button variant="secondary" iconLeft="refresh-cw" onClick={handleClick}>Retry</Button>
      </div>
    );
  }

  return (
    <Button
      variant="primary"
      iconLeft={phase === "confirming" ? undefined : "check"}
      disabled={phase === "confirming"}
      onClick={handleClick}
    >
      {phase === "confirming" ? "Marking as applied…" : "Mark as applied"}
    </Button>
  );
}
