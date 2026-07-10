import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TrackerTable, type SortSpec } from "../compositions/Tracker/TrackerTable";
import { applications } from "../fixtures";

const meta: Meta = {
  title: "Pages/Tracker",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// Pages/Tracker — the F5 console (treatment C) assembled on the `applications`
// fixture: header + TrackerTable (Active/Closed tabs, sortable columns,
// StagePips, statusTone Tag, tailored flag).
function TrackerPage() {
  const [sort, setSort] = React.useState<SortSpec>({ key: "appliedAt", dir: "desc" });

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
          rows={applications}
          sort={sort}
          onSort={setSort}
          onOpen={(id) => console.log("open", id)}
          onLogUpdate={(id) => console.log("log-update", id)}
          onGoToFeed={() => console.log("go to feed")}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <TrackerPage />,
};
