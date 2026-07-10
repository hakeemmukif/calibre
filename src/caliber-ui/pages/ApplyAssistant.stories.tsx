import type { Meta, StoryObj } from "@storybook/react";
import { ApplyQuestionsAssistant } from "../compositions/Apply/ApplyQuestionsAssistant";
import type { RegenerateMode } from "../compositions/Apply/AnswerCard";
import { jobs, resume, questions, answers as answersFixture } from "../fixtures";
import type { ApplicationQuestion, ApplicationAnswer, ApplicationAnswers } from "../../types";

const meta: Meta = {
  title: "Pages/ApplyAssistant",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

const job = jobs.find((j) => j.id === "job-grab-backend")!;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Page-level stand-ins for F4's LLM endpoints — same shape a real
// `features/apply/*` client would await, just resolved locally for the demo.
async function onExtract(): Promise<ApplicationQuestion[]> {
  await delay(700);
  return questions;
}

async function onDraft(): Promise<ApplicationAnswers> {
  await delay(900);
  return answersFixture;
}

async function onRegenerate(questionId: string, mode: RegenerateMode): Promise<ApplicationAnswer> {
  await delay(450);
  const seeded = answersFixture.answers.find((a) => a.questionId === questionId);
  void mode;
  return seeded ?? { questionId, prompt: "", answer: "", grounding: [] };
}

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
          onExtract={onExtract}
          onDraft={onDraft}
          onRegenerate={onRegenerate}
          onSaveAnswers={(answers) => console.log("save answers", answers)}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <ApplyAssistantPage />,
};
