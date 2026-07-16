"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Tag } from "../../components/Tag";
import type { AdminUser } from "../../../types";

export interface AdminUsersTableProps {
  users: AdminUser[];
  onGrant(id: string, delta: number): void;
  onTogglePlan(id: string, nextPlan: "standard" | "unlimited"): void;
}

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function AdminUserRow({
  user: u,
  onGrant,
  onTogglePlan,
}: {
  user: AdminUser;
  onGrant: (id: string, delta: number) => void;
  onTogglePlan: (id: string, nextPlan: "standard" | "unlimited") => void;
}) {
  const [delta, setDelta] = React.useState("");
  const nextPlan = u.plan === "unlimited" ? "standard" : "unlimited";

  const applyDelta = () => {
    const n = Number(delta);
    if (!Number.isInteger(n) || n === 0) return;
    onGrant(u.id, n);
    setDelta("");
  };

  return (
    <tr style={{ borderBottom: "1px solid var(--border-faint)" }}>
      <td style={{ ...tdStyle, font: "var(--type-h3)", color: "var(--text-strong)" }}>{u.email}</td>
      <td style={tdStyle}>
        <Tag tone={u.role === "admin" ? "verified" : "neutral"}>{u.role}</Tag>
      </td>
      <td style={tdStyle}>
        <Tag tone={u.plan === "unlimited" ? "verified" : "neutral"}>{u.plan}</Tag>
      </td>
      <td style={tdStyle}>{u.balance}</td>
      <td style={{ ...tdStyle, font: "var(--type-caption)", color: "var(--text-muted)" }}>{formatDate(u.createdAt)}</td>
      <td style={tdStyle}>{u.resumeCount}</td>
      <td style={tdStyle}>{u.jobCount}</td>
      <td style={tdStyle}>{u.applicationCount}</td>
      <td style={tdStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Button size="sm" onClick={() => onGrant(u.id, 150)}>
            +150 (pack)
          </Button>
          <Input
            aria-label={`Credit delta for ${u.email}`}
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            style={{ width: 72 }}
          />
          <Button size="sm" variant="ghost" onClick={applyDelta}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onTogglePlan(u.id, nextPlan)}>
            {u.plan === "unlimited" ? "Make standard" : "Make unlimited"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

// AdminUsersTable — the admin users list (Step 6 Task 3's GET
// /api/admin/users; membership-credits Task 10 adds the balance/plan columns
// and grant/plan-toggle row actions). Mirrors TrackerTable's Card-table
// treatment: hairline header row, faint row dividers, token typography. No
// sort/tabs — the admin roster is a flat, unfiltered list (MVP scale, per
// the plan).
export function AdminUsersTable({ users, onGrant, onTogglePlan }: AdminUsersTableProps) {
  if (users.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>No users yet.</span>
      </div>
    );
  }

  return (
    <Card padding="none" style={{ overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Role</th>
            <th style={thStyle}>Plan</th>
            <th style={thStyle}>Balance</th>
            <th style={thStyle}>Created</th>
            <th style={thStyle}>Résumés</th>
            <th style={thStyle}>Jobs</th>
            <th style={thStyle}>Applications</th>
            <th style={thStyle}>Credits</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <AdminUserRow key={u.id} user={u} onGrant={onGrant} onTogglePlan={onTogglePlan} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}
