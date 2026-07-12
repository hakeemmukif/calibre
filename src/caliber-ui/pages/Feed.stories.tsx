import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AppShellHeader } from "../compositions/Shell/AppShellHeader";
import { JobFeed, type JobRowAction } from "../compositions/Feed/JobFeed";
import type { FeedFilter } from "../compositions/Feed/FilterChips";
import type { UrlEvalStatus } from "../compositions/Shell/UrlEvalBar";
import type { Persona, SummaryStripStats } from "../../types";
import { jobs } from "../fixtures";

// Page-level stand-in for the `GET /api/jobs` response's server-computed
// `stats` — JobFeed itself never derives this from the jobs it's handed.
function statsFor(visibleJobs: typeof jobs): SummaryStripStats {
  return {
    scanned: visibleJobs.length,
    worth: visibleJobs.filter((j) => j.legitimacy.tier === "verified" || j.legitimacy.tier === "clear").length,
    ghosts: visibleJobs.filter((j) => j.ghost || j.legitimacy.tier === "ghost").length,
    flagged: visibleJobs.filter((j) => j.legitimacy.tier === "suspicious" || j.legitimacy.tier === "scam").length,
    sinceLast: visibleJobs.filter((j) => j.isNew).length,
    excluded: 0,
  };
}

const meta: Meta = {
  title: "Pages/Feed",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// Pages/Feed — the full §11.8 hero, assembled on fixtures: AppShellHeader
// (PersonaToggle · UrlEvalBar · NotificationBell) over JobFeed (which itself
// composes SummaryStrip · FilterChips · JobRow[]).
function FeedPage() {
  const [persona, setPersona] = React.useState<Persona>("remote");
  const [evalStatus, setEvalStatus] = React.useState<UrlEvalStatus>("idle");
  const [filter, setFilter] = React.useState<FeedFilter>("all");

  function handleEval(url: string) {
    setEvalStatus("evaluating");
    window.setTimeout(() => setEvalStatus("idle"), 900);
    console.log("eval", url);
  }

  function handleRowAction(id: string, action: JobRowAction) {
    console.log(id, action);
  }

  const visibleJobs = jobs.filter((j) => j.persona === persona);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <AppShellHeader
        persona={persona}
        onPersona={setPersona}
        evalStatus={evalStatus}
        onEval={handleEval}
        alertCount={2}
      />
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <JobFeed
          jobs={visibleJobs}
          filter={filter}
          onFilterChange={setFilter}
          stats={statsFor(visibleJobs)}
          loading={false}
          onRowAction={handleRowAction}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <FeedPage />,
};
