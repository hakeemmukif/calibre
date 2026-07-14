"use client";
import * as React from "react";
import { SidebarNav, type NavItem } from "@/caliber-ui/components";
import type { AuthUser } from "@/types";
import { ProfileChip } from "./ProfileChip";

// Full design-canonical sidebar — prototype parity (labels + icons + grouping).
// Only ids the caller marks enabled navigate; the rest stay here on purpose so
// the design is intact and re-enabling a tab later is one line. Do NOT delete
// hidden rows.
export const SIDEBAR_ITEMS: NavItem[] = [
  { section: "Pipeline" },
  { id: "matches", label: "Matches", icon: "target" },
  { id: "applied", label: "Applied", icon: "circle-check" },
  { id: "interviews", label: "Interviews", icon: "users" },
  { section: "Documents" },
  { id: "resume", label: "My resume", icon: "file-text" },
  { id: "cover", label: "Cover letters", icon: "mail" },
  { section: "Intelligence" },
  { id: "insights", label: "Insights", icon: "trending-up" },
  { id: "sources", label: "Sources", icon: "radar" },
  { section: "Setup" },
  { id: "profile", label: "Profile & targets", icon: "sliders-horizontal" },
];

// Appended only for admin users. The /admin PAGE is a later step — this item
// routes there now so the nav is ready when it lands.
export const ADMIN_SIDEBAR_ITEMS: NavItem[] = [
  { section: "Admin" },
  { id: "admin-users", label: "Users", icon: "users" },
];

export const DEFAULT_ENABLED = new Set(["matches", "applied", "resume", "sources", "profile"]);

// Drop disabled rows, then drop any section header left with no row beneath it.
function visibleItems(items: NavItem[], enabled: Set<string>): NavItem[] {
  const kept = items.filter((it) => it.section != null || enabled.has(it.id!));
  return kept.filter((it, i) => {
    if (it.section == null) return true;
    const next = kept[i + 1];
    return next != null && next.section == null;
  });
}

export interface AppSidebarProps {
  user?: AuthUser;
  activeId?: string;
  onSelect?: (id: string) => void;
  onLogout?: () => void;
}

// AppSidebar — the design-system SidebarNav wired with Caliber's nav rows and
// the signed-in user's ProfileChip/logout footer. Presentational only: no
// router/session access, so it renders (and stories) without a Next runtime.
// An "Admin" group appears only when `user.role === 'admin'`.
export function AppSidebar({ user, activeId, onSelect, onLogout }: AppSidebarProps) {
  const isAdmin = user?.role === "admin";
  const items = isAdmin ? [...SIDEBAR_ITEMS, ...ADMIN_SIDEBAR_ITEMS] : SIDEBAR_ITEMS;
  const enabled = isAdmin ? new Set([...DEFAULT_ENABLED, "admin-users"]) : DEFAULT_ENABLED;

  return (
    <SidebarNav
      items={visibleItems(items, enabled)}
      activeId={activeId}
      onSelect={onSelect}
      style={{ position: "sticky", top: 0, height: "100vh" }}
      footer={user ? <ProfileChip user={user} onLogout={onLogout} /> : null}
    />
  );
}
