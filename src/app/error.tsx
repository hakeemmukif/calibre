"use client";
import * as React from "react";
import { Button } from "@/caliber-ui/components/Button";
import { Card } from "@/caliber-ui/components/Card";
import { operatorTelegramUrl } from "@/caliber-ui/lib/support";
import { reportClientError } from "@/features/client-error/report";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg-app)" }}>
      <Card padding="lg" radius="lg" elevation="sm" style={{ width: 420 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>Caliber hit an error</div>
          <p style={{ font: "var(--type-body)", color: "var(--text-body)", margin: 0 }}>
            The crash was reported automatically. Reload to pick up where you left off.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={reset}>Try again</Button>
            <a
              href={operatorTelegramUrl()}
              target="_blank"
              rel="noreferrer"
              style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
            >
              Still broken? Message the operator on Telegram
            </a>
          </div>
        </div>
      </Card>
    </main>
  );
}
