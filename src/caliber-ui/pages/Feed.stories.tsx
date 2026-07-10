import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AppShellHeader } from "../compositions/Shell/AppShellHeader";
import { JobFeed, type JobRowAction } from "../compositions/Feed/JobFeed";
import type { FeedFilter } from "../compositions/Feed/FilterChips";
import type { UrlEvalStatus } from "../compositions/Shell/UrlEvalBar";
import type { Persona } from "../../types";
import { jobs } from "../fixtures";

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
          filter={"all" as FeedFilter}
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
