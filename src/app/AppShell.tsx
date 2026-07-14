"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppSidebar } from "@/caliber-ui/compositions/Shell/AppSidebar";
import { CheckDock } from "@/caliber-ui/compositions/Shell/CheckDock";
import type { AuthUser } from "@/types";
import { logout } from "@/features/auth/client";
import { __resetChecksStore } from "@/features/url-check/checksStore";

// Wired tabs. To light up a hidden tab later: add its id here + a routeFor entry.
const routeFor: Record<string, string> = {
  matches: "/feed",
  applied: "/tracker",
  resume: "/resume",
  sources: "/sources",
  profile: "/profile",
  "admin-users": "/admin",
};

// Route -> active nav id. /jobs/* are drill-downs from Matches, so keep Matches lit.
function activeIdFor(pathname: string): string | undefined {
  if (pathname === "/feed" || pathname.startsWith("/jobs")) return "matches";
  if (pathname.startsWith("/tracker")) return "applied";
  if (pathname.startsWith("/resume")) return "resume";
  if (pathname.startsWith("/sources")) return "sources";
  if (pathname.startsWith("/profile")) return "profile";
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
    }
    prevUserId.current = user?.id;
  }, [user?.id]);

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Session likely already invalid server-side — proceed to clear + redirect anyway.
    }
    __resetChecksStore();
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
      <CheckDock />
    </div>
  );
}
