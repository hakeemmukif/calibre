"use client";
// Admin page: users (Step 6 Task 3, GET /api/admin/users) + sources health
// (Track O task O.2, spec §4.3: dead/disabled sources "visibly disabled
// with a count on an admin surface"). Mirrors sources/page.tsx's
// busy/error/Retry pattern. The Admin nav item is already role-gated (Step
// 4), so a normal user reaching this URL directly only happens by typing it
// in — both APIs still enforce requireAdmin() and 403, which this page
// treats as a "no access" state rather than the generic error banner
// (defense in depth, not a second authorization system).
import * as React from "react";
import { AdminUsersTable } from "@/caliber-ui/compositions/Admin/AdminUsersTable";
import { Button } from "@/caliber-ui/components/Button";
import { Card } from "@/caliber-ui/components/Card";
import { Icon } from "@/caliber-ui/components/Icon";
import { Tag, type TagTone } from "@/caliber-ui/components/Tag";
import { getAdminUsers, getCrawlStatus, getSourcesHealth, grantCredits, patchUserPlan } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminCrawlStatus, AdminUser, SourcesHealthResponse } from "@/types";

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
  font: "var(--type-eyebrow)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-caps)",
  color: "var(--text-muted)",
};

const tdStyle: React.CSSProperties = { padding: "12px 16px" };

function stalenessTone(hours: number | null): TagTone {
  if (hours === null || hours > 48) return "danger";
  if (hours > 24) return "warn";
  return "good";
}

function stalenessLabel(hours: number | null): string {
  if (hours === null) return "never crawled";
  if (hours < 1) return "<1h ago";
  return `${Math.round(hours)}h ago`;
}

function formatElapsed(startedAtIso: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAtIso).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

// CrawlPanel — read-only Crawl status panel (spec 2026-07-17: the operator's
// live view of the global postings pool). Every section
// (pool/staleness/runningCrawl/lastRuns/perSource) can independently be null
// (the route degrades per-section rather than 500ing) — each block below
// renders its own "unavailable" fallback instead of assuming the whole
// response is well-formed.
function CrawlPanel({ data }: { data: AdminCrawlStatus }) {
  const { pool, staleness, runningCrawl, lastRuns, perSource } = data;
  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 12 }}>Crawl</div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "stretch" }}>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)" }}>Live pool</div>
          <div style={{ font: "700 28px/1.2 var(--font-display)", color: "var(--text-strong)" }}>
            {pool ? pool.live.toLocaleString() : "—"}
          </div>
          {pool && (
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
              {pool.delisted.toLocaleString()} delisted · {pool.total.toLocaleString()} total
            </div>
          )}
        </Card>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)", marginBottom: 6 }}>Staleness</div>
          <Tag tone={stalenessTone(staleness)}>{stalenessLabel(staleness)}</Tag>
        </Card>
      </div>

      {runningCrawl && (
        <Card padding="sm" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 20 }}>
          <Icon name="activity" size={18} />
          <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
            Crawl running — {runningCrawl.postingsSeenThisRun.toLocaleString()} postings seen · sources written{" "}
            {runningCrawl.sourcesWrittenThisRun}/{perSource?.totalSources ?? "?"} · elapsed {formatElapsed(runningCrawl.startedAt)}
          </div>
        </Card>
      )}

      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8, marginTop: 24 }}>
        Last runs
      </div>
      {!lastRuns ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>Unavailable.</div>
      ) : lastRuns.length === 0 ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>No completed crawl runs yet.</div>
      ) : (
        <>
          <Card padding="none" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Finished</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Duration</th>
                  <th style={thStyle}>Ok / Failed</th>
                  <th style={thStyle}>Skipped</th>
                  <th style={thStyle}>Upserts</th>
                  <th style={thStyle}>Delists</th>
                  <th style={thStyle}>Empty fetches</th>
                </tr>
              </thead>
              <tbody>
                {lastRuns.map((run) => (
                  <tr key={`${run.startedAt}-${run.finishedAt}`} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                    <td style={{ ...tdStyle, font: "var(--type-body)", color: "var(--text-strong)" }}>
                      {new Date(run.finishedAt).toLocaleString()}
                    </td>
                    <td style={tdStyle}>
                      <Tag tone={run.status === "completed" ? "good" : "danger"}>{run.status}</Tag>
                    </td>
                    <td style={tdStyle}>{formatDuration(run.durationMs)}</td>
                    <td style={tdStyle}>
                      {run.sourcesOk} / {run.sourcesFailed}
                    </td>
                    <td style={{ ...tdStyle, color: run.skipped !== 0 ? "var(--danger-ink)" : undefined, fontWeight: run.skipped !== 0 ? 700 : undefined }}>
                      {run.skipped}
                    </td>
                    <td style={tdStyle}>{run.upserts}</td>
                    <td style={tdStyle}>{run.delists}</td>
                    <td style={{ ...tdStyle, font: "var(--type-caption)", color: "var(--text-muted)" }}>
                      {run.emptyFetches.length > 0 ? run.emptyFetches.join(", ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 8 }}>
            upserts = churn, not growth — growth is the night-over-night live-count delta
          </div>
        </>
      )}

      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8, marginTop: 24 }}>
        Sources with the fewest live postings
      </div>
      {!perSource ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>Unavailable.</div>
      ) : (
        <Card padding="none" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Live postings</th>
                <th style={thStyle}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {perSource.items.map((row) => (
                <tr key={row.sourceId} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                  <td style={{ ...tdStyle, font: "var(--type-body)", color: "var(--text-strong)" }}>
                    {row.name}
                    <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{row.sourceId}</div>
                  </td>
                  <td style={tdStyle}>{row.liveCount}</td>
                  <td style={tdStyle}>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// SourcesHealthPanel — read-only v1 (spec: no re-enable action here; the
// existing sources page toggle flips `enabled` but never resets
// `status:'dead'`/`consecutiveFailures`, so a healed re-enable is a
// follow-up, not built here). Curated (hand-seeded) rows carry no
// provenance/health fields — that's shown as "—", never treated as a
// missing-data error.
function SourcesHealthPanel({ data }: { data: SourcesHealthResponse }) {
  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 12 }}>Sources health</div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)" }}>Total</div>
          <div style={{ font: "700 22px/1 var(--font-display)", color: "var(--text-strong)" }}>{data.total}</div>
        </Card>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)" }}>Enabled</div>
          <div style={{ font: "700 22px/1 var(--font-display)", color: "var(--text-strong)" }}>{data.enabledCount}</div>
        </Card>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)" }}>Dead</div>
          <div style={{ font: "700 22px/1 var(--font-display)", color: "var(--danger-ink)" }}>{data.deadCount}</div>
        </Card>
      </div>
      {data.items.length === 0 ? (
        <div style={{ padding: "24px 20px", textAlign: "center" }}>
          <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>No dead or disabled sources.</span>
        </div>
      ) : (
        <Card padding="none" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Failures</th>
                <th style={thStyle}>Last validated</th>
                <th style={thStyle}>Jobs</th>
                <th style={thStyle}>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.id} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                  <td style={{ ...tdStyle, font: "var(--type-h3)", color: "var(--text-strong)" }}>
                    {row.name}
                    <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{row.id}</div>
                  </td>
                  <td style={tdStyle}>
                    {row.error ? (
                      <>
                        <Tag tone="danger">error</Tag>
                        <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{row.error}</div>
                      </>
                    ) : (
                      <Tag tone={row.status === "dead" ? "danger" : "warn"}>
                        {row.status === "dead" ? "dead" : "disabled"}
                      </Tag>
                    )}
                  </td>
                  <td style={tdStyle}>{row.consecutiveFailures ?? "—"}</td>
                  <td style={tdStyle}>
                    {row.lastValidatedAt != null ? new Date(row.lastValidatedAt).toLocaleDateString() : "—"}
                  </td>
                  <td style={tdStyle}>{row.jobCount ?? "—"}</td>
                  <td style={tdStyle}>{row.provenance ? row.provenance.join(", ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [sourcesHealth, setSourcesHealth] = React.useState<SourcesHealthResponse | undefined>();
  const [crawlStatus, setCrawlStatus] = React.useState<AdminCrawlStatus | undefined>();
  const [loaded, setLoaded] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [sourcesError, setSourcesError] = React.useState<string | undefined>();
  const [crawlError, setCrawlError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    setForbidden(false);
    setSourcesError(undefined);
    setCrawlError(undefined);
    try {
      // S3b: getAdminUsers is the critical call — its failure still aborts
      // the page (403 → forbidden, other → the top banner). getSourcesHealth
      // and getCrawlStatus are not: a sick admin surface must not blank the
      // users table, so their rejections are mapped to local results here
      // instead of propagating into Promise.all's rejection path.
      const [nextUsers, sourcesResult, crawlResult] = await Promise.all([
        getAdminUsers(),
        getSourcesHealth().then(
          (data) => ({ data }),
          (err) => ({ error: err instanceof Error ? err.message : "Couldn't load sources health." }),
        ),
        getCrawlStatus().then(
          (data) => ({ data }),
          (err) => ({ error: err instanceof Error ? err.message : "Couldn't load crawl status." }),
        ),
      ]);
      setUsers(nextUsers);
      if ("error" in sourcesResult) {
        setSourcesError(sourcesResult.error);
      } else {
        setSourcesHealth(sourcesResult.data);
      }
      if ("error" in crawlResult) {
        setCrawlError(crawlResult.error);
      } else {
        setCrawlStatus(crawlResult.data);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't load admin data.");
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
  // to a slow idle cadence otherwise. Independent of `load` above (which only
  // fires once per page load / explicit retry) so this never touches
  // users/sourcesHealth. Cleans up on unmount and re-arms whenever the
  // running/not-running state flips.
  const crawlRunning = crawlStatus?.runningCrawl != null;
  React.useEffect(() => {
    if (forbidden) return;
    const intervalMs = crawlRunning ? 5000 : 60000;
    const id = setInterval(() => {
      getCrawlStatus().then(setCrawlStatus, () => {});
    }, intervalMs);
    return () => clearInterval(id);
  }, [crawlRunning, forbidden]);

  async function handleGrant(id: string, delta: number) {
    setError(undefined);
    try {
      await grantCredits(id, delta);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't grant credits.");
    }
  }

  async function handleTogglePlan(id: string, nextPlan: "standard" | "unlimited") {
    setError(undefined);
    try {
      await patchUserPlan(id, nextPlan);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update that user's plan.");
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Admin</span>
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
            {loaded && <AdminUsersTable users={users} onGrant={handleGrant} onTogglePlan={handleTogglePlan} />}
            {loaded && crawlError && (
              <div
                style={{
                  marginTop: 32,
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
                <span style={{ font: "var(--type-body)" }}>Couldn't load crawl status: {crawlError}</span>
              </div>
            )}
            {loaded && crawlStatus && <CrawlPanel data={crawlStatus} />}
            {loaded && sourcesError && (
              <div
                style={{
                  marginTop: 32,
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
                <span style={{ font: "var(--type-body)" }}>Couldn't load sources health: {sourcesError}</span>
              </div>
            )}
            {loaded && sourcesHealth && <SourcesHealthPanel data={sourcesHealth} />}
          </>
        )}
      </div>
    </div>
  );
}
