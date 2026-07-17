"use client";
import * as React from "react";
import { Button } from "@/caliber-ui/components/Button";
import { operatorTelegramUrl } from "@/caliber-ui/lib/support";
import { reportClientError } from "@/features/client-error/report";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "14px 18px",
          borderRadius: "var(--radius-sm)",
          background: "var(--danger-soft)",
          color: "var(--danger-ink)",
        }}
      >
        <span style={{ font: "var(--type-body)" }}>This page crashed. The error was reported automatically.</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button variant="secondary" onClick={reset}>Try again</Button>
          <a
            href={operatorTelegramUrl()}
            target="_blank"
            rel="noreferrer"
            style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
          >
            Message the operator on Telegram
          </a>
        </div>
      </div>
    </div>
  );
}
