"use client";
// M1 — the /scans list page (Scan Observability). Fetches run summaries via
// listScans (feed/tracker's useEffect + useCallback loader pattern) and
// renders them through ScansList. "Scan now" starts a run per ScanPersona
// and navigates straight to its detail; a 409 ActiveRunConflictError routes
// to the already-running run instead of erroring (409 ActiveRunConflictError
// reattaches to details.activeRunId rather than surfacing an error).
import * as React from "react";
import { useRouter } from "next/navigation";
import { ScansList } from "@/caliber-ui/compositions/Scans/ScansList";
import { Button } from "@/caliber-ui/components/Button";
import { listScans, startSearch } from "@/features/search/client";
import { ApiError } from "@/features/http";
import type { ScanPersona, SearchRunSummary } from "@/types";

const SCAN_PERSONAS: { value: ScanPersona; label: string }[] = [
  { value: "remote", label: "Remote" },
  { value: "local", label: "Malaysia" },
];

export default function ScansPage() {
  const router = useRouter();
  const [runs, setRuns] = React.useState<SearchRunSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | undefined>();
  const [launching, setLaunching] = React.useState<ScanPersona | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listScans();
      setRuns(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load scans.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleScanNow(persona: ScanPersona) {
    setLaunching(persona);
    setError(undefined);
    try {
      const run = await startSearch({ persona });
      router.push(`/scans/${run.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "CONFLICT") {
        const activeRunId =
          typeof err.details === "object" && err.details !== null && "activeRunId" in err.details
            ? (err.details as { activeRunId: unknown }).activeRunId
            : undefined;
        if (typeof activeRunId === "string") {
          router.push(`/scans/${activeRunId}`);
          return;
        }
      }
      setError(err instanceof Error ? err.message : "Couldn't start scan.");
    } finally {
      setLaunching(null);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>Scans</span>
          <div style={{ display: "flex", gap: 8 }}>
            {SCAN_PERSONAS.map((p) => (
              <Button
                key={p.value}
                variant="primary"
                iconLeft="search"
                onClick={() => void handleScanNow(p.value)}
                disabled={launching !== null}
              >
                Scan now · {p.label}
              </Button>
            ))}
          </div>
        </div>

        {error && (
          <div style={{ font: "var(--type-body)", color: "var(--danger-ink)", marginBottom: 12 }}>{error}</div>
        )}

        {loading ? (
          <div style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <ScansList runs={runs} onOpen={(id) => router.push(`/scans/${id}`)} />
        )}
      </div>
    </div>
  );
}
