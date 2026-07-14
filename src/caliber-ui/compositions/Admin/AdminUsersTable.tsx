"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Tag } from "../../components/Tag";
import type { AdminUser } from "../../../types";

export interface AdminUsersTableProps {
  users: AdminUser[];
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

// AdminUsersTable — the admin users list (Step 6 Task 3's GET
// /api/admin/users). Mirrors TrackerTable's Card-table treatment: hairline
// header row, faint row dividers, token typography. No sort/tabs — the
// admin roster is a flat, unfiltered list (MVP scale, per the plan).
export function AdminUsersTable({ users }: AdminUsersTableProps) {
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
            <th style={thStyle}>Created</th>
            <th style={thStyle}>Résumés</th>
            <th style={thStyle}>Jobs</th>
            <th style={thStyle}>Applications</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--border-faint)" }}>
              <td style={{ ...tdStyle, font: "var(--type-h3)", color: "var(--text-strong)" }}>{u.email}</td>
              <td style={tdStyle}>
                <Tag tone={u.role === "admin" ? "verified" : "neutral"}>{u.role}</Tag>
              </td>
              <td style={{ ...tdStyle, font: "var(--type-caption)", color: "var(--text-muted)" }}>{formatDate(u.createdAt)}</td>
              <td style={tdStyle}>{u.resumeCount}</td>
              <td style={tdStyle}>{u.jobCount}</td>
              <td style={tdStyle}>{u.applicationCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
