"use client";
// Crawl dashboard: split out of admin/page.tsx into its own /admin/crawl tab
// (spec 2026-07-17) so it isn't buried under Users. Same admin guard/degrade
// pattern as admin/page.tsx: getCrawlStatus() 403s the same way
// getAdminUsers() does, so a non-admin hitting this URL directly still lands
// on the "no access" state, not the generic error banner.
import * as React from "react";
import { CrawlPanel } from "@/caliber-ui/compositions/Admin/CrawlPanel";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getCrawlStatus } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminCrawlStatus } from "@/types";

export default function AdminCrawlPage() {
  const [crawlStatus, setCrawlStatus] = React.useState<AdminCrawlStatus | undefined>();
  const [loaded, setLoaded] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    setForbidden(false);
    try {
      const data = await getCrawlStatus();
      setCrawlStatus(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't load crawl status.");
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Live fill strip: polls the crawl endpoint on its own cadence, faster
  // while a crawl is in flight so the counters actually move, dropping back
  // to a slow idle cadence otherwise. Cleans up on unmount and re-arms
  // whenever the running/not-running state flips.
  const crawlRunning = crawlStatus?.runningCrawl != null;
  React.useEffect(() => {
    if (forbidden) return;
    const intervalMs = crawlRunning ? 5000 : 60000;
    const id = setInterval(() => {
      getCrawlStatus().then(setCrawlStatus, () => {});
    }, intervalMs);
    return () => clearInterval(id);
  }, [crawlRunning, forbidden]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Crawl</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {forbidden ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
            <Icon name="shield" size={20} />
            <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>You do not have access to this page.</span>
          </div>
        ) : (
          <>
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
            {loaded && crawlStatus && <CrawlPanel data={crawlStatus} />}
          </>
        )}
      </div>
    </div>
  );
}
