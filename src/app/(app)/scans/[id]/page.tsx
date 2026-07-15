"use client";
// /scans/:id — phased replay of a terminal run (M1 §4.3). A running run
// reuses the existing coarse useScanRun + ScanProgress bridge (the explicit
// M1 placeholder until M2 adds live lanes) — do not retire or modify that
// pair here. A terminal run renders the persisted-results ScanReplay.
import * as React from "react";
import { useParams } from "next/navigation";
import { ScanReplay } from "@/caliber-ui/compositions/Scans/ScanReplay";
import { ScanProgress } from "@/caliber-ui/compositions/Feed/ScanProgress";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getScanDetail } from "@/features/search/client";
import { useScanRun } from "@/features/search/useScanRun";
import { ApiError } from "@/features/http";
import type { ScanDetail } from "@/types";

export default function ScanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = React.useState<ScanDetail | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const scanRun = useScanRun({ onDone: () => void load() });

  const load = React.useCallback(async () => {
    setError(undefined);
    setNotFound(false);
    try {
      const fetched = await getScanDetail(id);
      setDetail(fetched);
      if (fetched.status === "running" || fetched.status === "queued") scanRun.subscribeTo(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't load this scan.");
    }
    // scanRun.subscribeTo has a stable identity (useCallback([])) — safe to
    // omit from deps; re-including `scanRun` would re-run this effect every
    // render since useScanRun() returns a fresh object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // useScanRun has no onError option — the SSE `error` event only surfaces
  // through scanRun.state.status. Refetch on that transition too, so a run
  // that fails mid-flight also leaves the "running" view (mirrors onDone).
  React.useEffect(() => {
    if (scanRun.state.status === "error") void load();
  }, [scanRun.state.status, load]);

  if (notFound) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
        <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--surface-sunken)",
              color: "var(--text-muted)",
            }}
          >
            <Icon name="circle-help" size={16} />
            <span style={{ font: "var(--type-body)" }}>Scan not found.</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
        <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--danger-soft)",
              color: "var(--danger-ink)",
            }}
          >
            <Icon name="triangle-alert" size={16} />
            <span style={{ font: "var(--type-body)" }}>{error}</span>
          </div>
          <Button variant="secondary" iconLeft="refresh-cw" style={{ marginTop: 12 }} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  if (detail.status === "running" || detail.status === "queued") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24, display: "flex", justifyContent: "center" }}>
        <ScanProgress
          status={scanRun.state.status === "error" ? "error" : "running"}
          stages={scanRun.state.stages}
          error={scanRun.state.error}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
        <ScanReplay detail={detail} />
      </div>
    </div>
  );
}
