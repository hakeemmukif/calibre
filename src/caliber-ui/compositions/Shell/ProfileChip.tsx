"use client";
import * as React from "react";
import { Avatar, IconButton } from "@/caliber-ui/components";
import type { AuthUser } from "@/types";

export interface ProfileChipProps {
  user: AuthUser;
  /** Omit to render without the logout affordance. */
  onLogout?: () => void;
}

// ProfileChip — the signed-in user's identity + logout affordance, shown in
// the sidebar footer. Always the real session's email/role; never a fake name.
export function ProfileChip({ user, onLogout }: ProfileChipProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", minWidth: 0 }}>
        <Avatar name={user.email} size="sm" />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              font: "var(--type-label)",
              color: "var(--text-strong)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user.email}
          </div>
          <div
            style={{
              font: "var(--type-caption)",
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user.role}
          </div>
        </div>
      </div>
      {onLogout && <IconButton icon="log-out" label="Log out" size="sm" onClick={onLogout} />}
    </div>
  );
}
