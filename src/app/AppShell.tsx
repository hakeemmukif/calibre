"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppSidebar } from "@/caliber-ui/compositions/Shell/AppSidebar";
import { CheckDock } from "@/caliber-ui/compositions/Shell/CheckDock";
import { InsufficientCreditsDialog } from "@/caliber-ui/compositions/Shell/InsufficientCreditsDialog";
import { Chip } from "@/caliber-ui/components/Chip";
import type { AuthUser } from "@/types";
import { logout } from "@/features/auth/client";
import { __resetChecksStore } from "@/features/url-check/checksStore";
import { __resetCreditsStore, refreshCredits, useCredits } from "@/features/credits/creditsStore";
import { identify, resetAnalytics } from "@/features/analytics/client";

// CreditsChip — mounted once in the shell; refreshes on mount and hides
// while the balance hasn't loaded yet or the user is on the unlimited plan
// (spec §4.4). Sits one z-index below CheckDock's fixed corner tray (40).
function CreditsChip() {
  React.useEffect(() => { refreshCredits(); }, []);
  const { balance, plan } = useCredits();
  if (balance === null || plan === "unlimited") return null;
  return (
    <div style={{ position: "fixed", top: 16, right: 24, zIndex: 39, pointerEvents: "none" }}>
      <Chip style={{ pointerEvents: "auto" }}>⬡ {balance} credits</Chip>
    </div>
  );
}

// Wired tabs. To light up a hidden tab later: add its id here + a routeFor entry.
const routeFor: Record<string, string> = {
  matches: "/feed",
  applied: "/tracker",
  scans: "/scans",
  resume: "/resume",
  sources: "/sources",
  profile: "/profile",
  "admin-users": "/admin",
  "admin-crawl": "/admin/crawl",
  "admin-pool": "/admin/pool",
};

// Route -> active nav id. /jobs/* are drill-downs from Matches, so keep Matches lit.
function activeIdFor(pathname: string): string | undefined {
  if (pathname === "/feed" || pathname.startsWith("/jobs")) return "matches";
  if (pathname.startsWith("/tracker")) return "applied";
  if (pathname.startsWith("/scans")) return "scans";
  if (pathname.startsWith("/resume")) return "resume";
  if (pathname.startsWith("/sources")) return "sources";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/admin/crawl")) return "admin-crawl";
  if (pathname.startsWith("/admin/pool")) return "admin-pool";
  if (pathname.startsWith("/admin")) return "admin-users";
  return undefined;
}

// AppShell — mounts AppSidebar around every routed page and drives it from
// the router (active tab from pathname, navigation via push).
export function AppShell({ children, user }: { children: React.ReactNode; user?: AuthUser }) {
  const pathname = usePathname();
  const router = useRouter();

  // Re-login as a different user must start every client-side store clean.
  // Only reset when the id actually CHANGES from a previous non-null id —
  // never on initial mount.
  const prevUserId = React.useRef(user?.id);
  React.useEffect(() => {
    if (prevUserId.current !== undefined && prevUserId.current !== user?.id) {
      __resetChecksStore();
      __resetCreditsStore();
      resetAnalytics();
    }
    prevUserId.current = user?.id;
    // Internal id only — never email/name (spec §4).
    if (user?.id) identify(user.id);
  }, [user?.id]);

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Session likely already invalid server-side — proceed to clear + redirect anyway.
    }
    __resetChecksStore();
    __resetCreditsStore();
    resetAnalytics();
    router.push("/login");
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-app)" }}>
      <AppSidebar
        user={user}
        activeId={activeIdFor(pathname ?? "")}
        onSelect={(id) => {
          const to = routeFor[id];
          if (to) router.push(to);
        }}
        onLogout={() => void handleLogout()}
      />
      <main style={{ flex: 1, overflow: "auto", height: "100vh" }}>{children}</main>
      <CreditsChip />
      <CheckDock />
      <InsufficientCreditsDialog />
    </div>
  );
}
