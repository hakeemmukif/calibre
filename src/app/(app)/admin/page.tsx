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
import { Tag } from "@/caliber-ui/components/Tag";
import { getAdminUsers, getSourcesHealth, grantCredits, patchUserPlan } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminUser, SourcesHealthResponse } from "@/types";

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
  const [loaded, setLoaded] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [sourcesError, setSourcesError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    setForbidden(false);
    setSourcesError(undefined);
    try {
      // S3b: getAdminUsers is the critical call — its failure still aborts
      // the page (403 → forbidden, other → the top banner). getSourcesHealth
      // is not: a sick admin surface must not blank the users table, so its
      // rejection is mapped to a local result here instead of propagating
      // into Promise.all's rejection path.
      const [nextUsers, sourcesResult] = await Promise.all([
        getAdminUsers(),
        getSourcesHealth().then(
          (data) => ({ data }),
          (err) => ({ error: err instanceof Error ? err.message : "Couldn't load sources health." }),
        ),
      ]);
      setUsers(nextUsers);
      if ("error" in sourcesResult) {
        setSourcesError(sourcesResult.error);
      } else {
        setSourcesHealth(sourcesResult.data);
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
