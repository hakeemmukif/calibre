"use client";
// Sources management page, wired to the real backend (component-inventory.md
// SourceList; api-contract.md §3 "GET /api/sources", "PATCH
// /api/sources/:id"). Per-row toggle is optimistic-free: set busyId, PATCH,
// replace the row from the response, clear busyId. A failed load or toggle
// keeps prior state (the list already on screen never gets cleared) and
// surfaces an inline error + Retry (mirrors feed/page.tsx's error styling).
import * as React from "react";
import { SourceList } from "@/caliber-ui/compositions/Sources/SourceList";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { listSources, setSourceEnabled } from "@/features/sources/client";
import type { Source } from "@/types";

export default function SourcesPage() {
  const [sources, setSources] = React.useState<Source[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    try {
      setSources(await listSources());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load sources.");
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(id: string, enabled: boolean) {
    setBusyId(id);
    setError(undefined);
    try {
      const updated = await setSourceEnabled(id, enabled);
      setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update that source.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Sources</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--danger-soft)",
              color: "var(--danger-ink)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="triangle-alert" size={16} />
              <span style={{ font: "var(--type-body)" }}>{error}</span>
            </div>
            <Button variant="secondary" iconLeft="refresh-cw" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
        {loaded && <SourceList sources={sources} busyId={busyId} onToggle={handleToggle} />}
      </div>
    </div>
  );
}
