"use client";
import * as React from "react";
import { IconButton } from "../../components/IconButton";

export interface NotificationBellProps {
  count: number;
  onClick?(): void;
}

// NotificationBell — IconButton + count badge (§11.4): "N new roles match
// your targets" alerting, surfaced in AppShellHeader.
export function NotificationBell({ count, onClick }: NotificationBellProps) {
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <IconButton icon="bell" label="Notifications" onClick={onClick} />
      {count > 0 && (
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: "var(--radius-pill, 999px)",
            background: "var(--accent)",
            color: "var(--ink-900)",
            font: "700 10px/16px var(--font-body)",
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </div>
  );
}
