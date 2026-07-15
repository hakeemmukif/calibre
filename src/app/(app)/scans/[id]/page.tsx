"use client";
// /scans/:id — phased replay of a terminal run (M1 §4.3). A running (or
// queued) run renders the live concurrency-lane view (M2 T7): SourceStrip +
// ScanLanes fed by useScanLive. When the live run reaches a terminal status
// (done/error), we refetch getScanDetail so `detail` flips terminal and the
// page swaps to the persisted-results ScanReplay.
import * as React from "react";
import { useParams } from "next/navigation";
import { ScanReplay } from "@/caliber-ui/compositions/Scans/ScanReplay";
import { SourceStrip } from "@/caliber-ui/compositions/Scans/SourceStrip";
import { ScanLanes } from "@/caliber-ui/compositions/Scans/ScanLanes";
import { Tag } from "@/caliber-ui/components/Tag";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getScanDetail } from "@/features/search/client";
import { useScanLive } from "@/features/search/useScanLive";
import { ApiError } from "@/features/http";
import type { ScanDetail } from "@/types";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export default function ScanDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed by `id` so navigating between runs remounts the view entirely —
  // useScanLive's useReducer state lives in this component, and a `key` on
  // a descendant can't reset an ancestor's hook state (M2 T7 review fix).
  return <ScanDetailView key={id} id={id} />;
}

function ScanDetailView({ id }: { id: string }) {
  const [detail, setDetail] = React.useState<ScanDetail | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const live = useScanLive(detail?.status === "running" || detail?.status === "queued" ? id : null);

  const load = React.useCallback(async () => {
    setError(undefined);
    setNotFound(false);
    try {
      const fetched = await getScanDetail(id);
      setDetail(fetched);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't load this scan.");
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A live run's SSE stream reaches a terminal status (done/error) — refetch
  // so `detail` flips terminal and the page swaps to ScanReplay.
  React.useEffect(() => {
    if (live.status === "done" || live.status === "error") void load();
  }, [live.status, load]);

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
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
        <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{detail.resumeName}</span>
            <Tag tone="neutral">{detail.persona}</Tag>
            <span style={{ font: "var(--type-body)", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {formatElapsed(Date.now() - new Date(detail.startedAt).getTime())}
            </span>
          </div>
          <SourceStrip sources={live.state.sources} />
          <ScanLanes activeJobs={live.state.activeJobs} counts={live.state.counts} />
        </div>
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
