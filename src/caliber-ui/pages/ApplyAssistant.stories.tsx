import type { Meta, StoryObj } from "@storybook/react";
import { ApplyQuestionsAssistant } from "../compositions/Apply/ApplyQuestionsAssistant";
import { jobs, resume, questions } from "../fixtures";

const meta: Meta = {
  title: "Pages/ApplyAssistant",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

const job = jobs.find((j) => j.id === "job-grab-backend")!;

// Pages/ApplyAssistant — F4 rendered as a full page (`/jobs/[id]/questions`),
// launched from JobDetail's "Answer questions" — not a modal, per §2.
function ApplyAssistantPage() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 960px)", margin: "0 auto" }}>
        <ApplyQuestionsAssistant
          job={job}
          resume={resume}
          detected={questions}
          onSaveAnswers={(answers) => console.log("save answers", answers)}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <ApplyAssistantPage />,
};
