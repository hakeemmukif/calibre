"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import { Button } from "../../components/Button";
import { useUrlChecks } from "@/features/url-check/checksStore";
import { CheckRunRow } from "./CheckRunRow";

export function CheckDock() {
  const pathname = usePathname();
  const router = useRouter();
  const { runs, active, doneCount, dismiss, retryWithText, clearFinished } = useUrlChecks();
  const [expanded, setExpanded] = React.useState(false);
  const [seenDone, setSeenDone] = React.useState(0);

  // Hidden on /feed (inline ScoringStatusCard owns it) and when idle.
  if (pathname === "/feed" || runs.length === 0) return null;

  const unseen = Math.max(0, doneCount - seenDone);
  const shown = runs.slice(0, 5);
  const overflow = runs.length - shown.length;

  return (
    <div style={{ position: "fixed", right: 24, bottom: 24, zIndex: 40, width: expanded ? 320 : undefined }}>
      <Card radius="xl" elevation="lg" padding={expanded ? "md" : "sm"}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-ink)", flexShrink: 0,
            animation: active.length > 0 ? "caliber-pulse 1.6s ease-in-out infinite alternate" : undefined }} />
          <div style={{ flex: 1, font: "var(--type-label)", color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>
            {active.length > 0 ? `Scoring ${active.length} role${active.length === 1 ? "" : "s"}` : "Checks"}
            {unseen > 0 && <span style={{ marginLeft: 6, font: "var(--type-caption)", color: "var(--accent-ink)" }}>{unseen} done</span>}
          </div>
          <IconButton icon={expanded ? "chevron-down" : "chevron-up"} label={expanded ? "Collapse" : "Expand"}
            onClick={() => { setExpanded((v) => !v); setSeenDone(doneCount); }} />
        </div>
        {expanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {shown.map((run) => (
              <CheckRunRow key={run.key} run={run}
                onOpen={(jobId) => router.push(`/jobs/${jobId}`)}
                onRetry={(key) => retryWithText(key, "")}
                onPasteText={() => router.push("/feed")}
                onDismiss={dismiss} />
            ))}
            {overflow > 0 && <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", padding: "4px" }}>+{overflow} more</div>}
            <Button variant="ghost" fullWidth onClick={clearFinished} style={{ marginTop: 4 }}>Clear finished</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
