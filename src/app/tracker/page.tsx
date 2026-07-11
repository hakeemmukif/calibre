"use client";
// F5 — the lifelong tracker console, wired to the real backend
// (component-inventory.md TrackerTable; api-contract.md §3 "GET
// /api/applications", "PATCH /api/applications/:id"). No dedicated
// "log update" UI is specified in component-inventory.md — `onLogUpdate`
// is wired to a minimal prompt() for a note, the only field every stage
// change plausibly wants recorded; documented as a pragmatic minimum, not a
// new designed component.
import * as React from "react";
import { useRouter } from "next/navigation";
import { TrackerTable, type SortSpec } from "@/caliber-ui/compositions/Tracker/TrackerTable";
import { listApplications, patchApplication } from "@/features/applied/client";
import type { Application } from "@/types";

export default function TrackerPage() {
  const router = useRouter();
  const [rows, setRows] = React.useState<Application[]>([]);
  const [sort, setSort] = React.useState<SortSpec>({ key: "appliedAt", dir: "desc" });

  const load = React.useCallback(async () => {
    const result = await listApplications({ limit: 100 });
    setRows(result.items);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function onOpen(id: string) {
    const row = rows.find((r) => r.id === id);
    if (row) router.push(`/jobs/${row.jobId}`);
  }

  async function onLogUpdate(id: string) {
    const note = window.prompt("Log an update for this application:");
    if (note === null) return;
    await patchApplication(id, { note });
    void load();
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Application tracker</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <TrackerTable
          rows={rows}
          sort={sort}
          onSort={setSort}
          onOpen={onOpen}
          onLogUpdate={onLogUpdate}
          onGoToFeed={() => router.push("/feed")}
        />
      </div>
    </div>
  );
}
