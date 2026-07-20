"use client";
// Pool dashboard: admin-only stats view over the global postings pool (spec
// 2026-07-21-admin-pool-tab-design.md). Same admin guard/degrade pattern as
// admin/crawl/page.tsx: getPoolStats() 403s the same way getCrawlStatus()
// does, so a non-admin hitting this URL directly lands on the "no access"
// state, not the generic error banner. PoolPanel owns its own loading/
// empty-state rendering (unlike CrawlPanel), so this page is a thin fetch+forbidden
// wrapper.
import * as React from "react";
import { PoolPanel } from "@/caliber-ui/compositions/Admin/PoolPanel";
import { Icon } from "@/caliber-ui/components/Icon";
import { getPoolStats } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminPoolStats } from "@/types";

export default function AdminPoolPage() {
  const [stats, setStats] = React.useState<AdminPoolStats | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setForbidden(false);
    try {
      const data = await getPoolStats();
      setStats(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't load pool stats.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Pool</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {forbidden ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
            <Icon name="shield" size={20} />
            <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>You do not have access to this page.</span>
          </div>
        ) : (
          <PoolPanel stats={stats} loading={loading} error={error} onRetry={() => void load()} />
        )}
      </div>
    </div>
  );
}
