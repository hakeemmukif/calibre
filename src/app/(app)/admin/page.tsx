"use client";
// Admin users page (Step 6 Task 3): lists every account with per-user
// counts (Step 6 Task 1's GET /api/admin/users). Mirrors sources/page.tsx's
// busy/error/Retry pattern. The Admin nav item is already role-gated (Step
// 4), so a normal user reaching this URL directly only happens by typing it
// in — the API still enforces requireAdmin() and 403s, which this page
// treats as a "no access" state rather than the generic error banner
// (defense in depth, not a second authorization system).
import * as React from "react";
import { AdminUsersTable } from "@/caliber-ui/compositions/Admin/AdminUsersTable";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getAdminUsers } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminUser } from "@/types";

export default function AdminPage() {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    setForbidden(false);
    try {
      setUsers(await getAdminUsers());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't load users.");
      }
    } finally {
      setLoaded(true);
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
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Admin · Users</span>
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
            {loaded && <AdminUsersTable users={users} />}
          </>
        )}
      </div>
    </div>
  );
}
