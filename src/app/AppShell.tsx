"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { SidebarNav, Avatar, type NavItem } from "@/caliber-ui/components";

// Full design-canonical sidebar — prototype parity (labels + icons + grouping).
// Only the ids in ENABLED navigate; the rest stay here on purpose so the design
// is intact and re-enabling a tab later is one line. Do NOT delete hidden rows.
const ITEMS: NavItem[] = [
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

// Wired tabs. To light up a hidden tab later: add its id here + a routeFor entry.
const ENABLED = new Set(["matches", "applied", "resume"]);
const routeFor: Record<string, string> = {
  matches: "/feed",
  applied: "/tracker",
  resume: "/resume",
};

// Route -> active nav id. /jobs/* are drill-downs from Matches, so keep Matches lit.
function activeIdFor(pathname: string): string | undefined {
  if (pathname === "/feed" || pathname.startsWith("/jobs")) return "matches";
  if (pathname.startsWith("/tracker")) return "applied";
  if (pathname.startsWith("/resume")) return "resume";
  return undefined;
}

// Drop disabled rows, then drop any section header left with no row beneath it.
function visibleItems(): NavItem[] {
  const kept = ITEMS.filter((it) => it.section != null || ENABLED.has(it.id!));
  return kept.filter((it, i) => {
    if (it.section == null) return true;
    const next = kept[i + 1];
    return next != null && next.section == null;
  });
}

// Placeholder chip until profile data lands — prototype parity (avatar + name + role).
function ProfileChip() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", minWidth: 0 }}>
      <Avatar name="Alex Tan" size="sm" />
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
          Alex Tan
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
          Product Designer
        </div>
      </div>
    </div>
  );
}

// AppShell — mounts the design-system SidebarNav around every routed page and
// drives it from the router (active tab from pathname, navigation via push).
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-app)" }}>
      <SidebarNav
        items={visibleItems()}
        activeId={activeIdFor(pathname ?? "")}
        onSelect={(id) => {
          const to = routeFor[id];
          if (to) router.push(to);
        }}
        style={{ position: "sticky", top: 0, height: "100vh" }}
        footer={<ProfileChip />}
      />
      <main style={{ flex: 1, overflow: "auto", height: "100vh" }}>{children}</main>
    </div>
  );
}
