import type { Meta, StoryObj } from "@storybook/react";
import { ApplyQuestionsAssistant } from "./ApplyQuestionsAssistant";
import type { IntakeMode } from "./QuestionIntake";
import type { RegenerateMode } from "./AnswerCard";
import { jobs, resume, questions, answers as answersFixture } from "../../fixtures";
import type { ApplicationQuestion, ApplicationAnswer, ApplicationAnswers } from "../../../types";

const meta: Meta<typeof ApplyQuestionsAssistant> = {
  title: "Compositions/Apply/ApplyQuestionsAssistant",
  component: ApplyQuestionsAssistant,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ApplyQuestionsAssistant>;

const job = jobs.find((j) => j.id === "job-grab-backend")!;
const noopSave = (a: unknown) => console.log("save answers", a);

let nextId = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// simulateExtract — the stand-in for POST /api/apply/questions.
async function simulateExtract(mode: IntakeMode, text: string): Promise<ApplicationQuestion[]> {
  await delay(700);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 5 || text.toLowerCase().includes("no questions")) {
    throw new Error("Couldn't find any questions in that text — try Paste JD, or add them manually.");
  }
  void mode;
  return [
    { id: `q-${nextId++}`, prompt: "Why do you want to work here?", kind: "textarea", required: true, maxLength: 600 },
    { id: `q-${nextId++}`, prompt: "Describe relevant experience for this role.", kind: "textarea", required: true, maxLength: 800 },
    { id: `q-${nextId++}`, prompt: "Are you authorized to work in this location?", kind: "boolean", required: true },
  ];
}

// draftAnswerFor — deterministic per-question drafting: reuses the seeded
// fixture answer when the job/question matches job-grab-backend's q1–q3,
// otherwise synthesizes a résumé-grounded draft from `resume.summary` + the
// most recent bullet. Boolean questions draft with empty grounding — the
// real "not found in résumé" signal, per the api-contract's empty-grounding
// convention.
function draftAnswerFor(question: ApplicationQuestion, seeded?: ApplicationAnswer): ApplicationAnswer {
  if (seeded) return seeded;
  if (question.kind === "boolean") {
    return { questionId: question.id, prompt: question.prompt, answer: "Yes", grounding: [] };
  }
  const bullet = resume.experience[0]?.bullets[0];
  const text = `${resume.summary ?? ""} ${bullet ? `For example: ${bullet}` : ""}`.trim();
  const clipped = question.maxLength ? text.slice(0, question.maxLength) : text;
  return {
    questionId: question.id,
    prompt: question.prompt,
    answer: clipped,
    grounding: [
      ...(resume.summary ? ([{ source: "summary" as const, quote: resume.summary }]) : []),
      ...(bullet ? ([{ source: "experience" as const, quote: bullet }]) : []),
    ],
  };
}

// simulateDraft — the stand-in for POST /api/apply/answers.
async function simulateDraft(questionsToDraft: ApplicationQuestion[]): Promise<ApplicationAnswers> {
  await delay(900);
  const seededById = new Map(answersFixture.answers.map((a) => [a.questionId, a]));
  return {
    ...answersFixture,
    answers: questionsToDraft.map((q) => {
      const seeded = job.id === answersFixture.jobId ? seededById.get(q.id) : undefined;
      return draftAnswerFor(q, seeded);
    }),
  };
}

// simulateRegenerate — the stand-in for a targeted answer redraft.
async function simulateRegenerate(questionId: string, mode: RegenerateMode): Promise<ApplicationAnswer> {
  await delay(450);
  const seeded = answersFixture.answers.find((a) => a.questionId === questionId);
  const prompt = questions.find((q) => q.id === questionId)?.prompt ?? "";
  const base = seeded?.answer ?? "";
  const text =
    mode === "shorter"
      ? base.slice(0, Math.max(40, Math.floor(base.length * 0.6))).trim()
      : mode === "more-formal"
        ? `I would like to note that ${base.charAt(0).toLowerCase()}${base.slice(1)}`
        : `${base} Specifically, ${resume.experience[0]?.bullets[0]?.toLowerCase() || "this drew directly on my recent work"}.`;
  return { questionId, prompt, answer: text, grounding: seeded?.grounding ?? [] };
}

// NoIntakeIdle — no pre-extracted form for this posting: the assistant opens
// on QuestionIntake with Detected empty, ready for Paste form / Paste JD.
export const NoIntakeIdle: Story = {
  args: { job, resume, onExtract: simulateExtract, onDraft: simulateDraft, onRegenerate: simulateRegenerate, onSaveAnswers: noopSave },
};

// DetectedReview — a known-ATS form arrives pre-extracted; intake is
// skipped straight to the editable question review.
export const DetectedReview: Story = {
  args: {
    job,
    resume,
    detected: questions,
    onExtract: simulateExtract,
    onDraft: simulateDraft,
    onRegenerate: simulateRegenerate,
    onSaveAnswers: noopSave,
  },
};

// Answering — click "Draft all answers" in DetectedReview to reach this;
// pinned here for docs via the same fixtures, one click away in Canvas.
export const Answering: Story = {
  args: {
    job,
    resume,
    detected: questions,
    onExtract: simulateExtract,
    onDraft: simulateDraft,
    onRegenerate: simulateRegenerate,
    onSaveAnswers: noopSave,
  },
  parameters: {
    docs: { description: { story: "Click \"Draft all answers\" to watch each AnswerCard stream from drafting → ready." } },
  },
};
