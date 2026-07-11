"use client";
// F4 — application-question assistant, wired to the real backend
// (component-inventory.md §2 ApplyQuestionsAssistant; api-contract.md §3
// "POST /api/apply/questions", "POST /api/apply/answers",
// "PATCH /api/apply/answers/:id"). Renders as a full page, not a modal
// (§2), launched from JobDetail's "Answer questions".
//
// Known gap: ApplyQuestionsAssistant's `onRegenerate(questionId, mode)` prop
// only carries the question id + a UI-only regen hint — there is no
// mode-aware regenerate endpoint in the frozen contract (draftAnswers
// re-runs the full LLM draft; PATCH only persists user edits). Regenerate is
// implemented here as a single-question re-draft via POST /api/apply/answers
// that ignores `mode` — flagged, not solved by inventing a new endpoint.
import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ApplyQuestionsAssistant } from "@/caliber-ui/compositions/Apply/ApplyQuestionsAssistant";
import type { IntakeMode } from "@/caliber-ui/compositions/Apply/QuestionIntake";
import type { RegenerateMode } from "@/caliber-ui/compositions/Apply/AnswerCard";
import { draftAnswers, extractQuestions, patchAnswers } from "@/features/apply/client";
import { getJob } from "@/features/feed/client";
import { getResume } from "@/features/resume/client";
import type { ApplicationAnswer, ApplicationQuestion, Job, Resume } from "@/types";

export default function ApplyAssistantPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = React.useState<Job | null>(null);
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [detected, setDetected] = React.useState<ApplicationQuestion[] | undefined>();
  const [loaded, setLoaded] = React.useState(false);

  const questionsById = React.useRef<Record<string, ApplicationQuestion>>({});
  const answersId = React.useRef<string | undefined>(undefined);

  function remember(questions: ApplicationQuestion[]) {
    for (const q of questions) questionsById.current[q.id] = q;
  }

  React.useEffect(() => {
    void (async () => {
      const [fetchedJob, fetchedResume] = await Promise.all([getJob(id), getResume()]);
      setJob(fetchedJob);
      setResume(fetchedResume);
      // Tier 1/2 (ATS API / DOM parse) — a known-ATS form arrives
      // pre-extracted; a 502 EXTRACTION_FAILED here just means neither tier
      // found a form, so intake falls through to the paste tabs.
      try {
        const result = await extractQuestions({ jobId: id });
        remember(result.questions);
        setDetected(result.questions);
      } catch {
        setDetected(undefined);
      } finally {
        setLoaded(true);
      }
    })();
  }, [id]);

  async function onExtract(mode: IntakeMode, text: string): Promise<ApplicationQuestion[]> {
    void mode; // both paste-form/paste-jd map to the single `pastedForm` tier-3 field
    const result = await extractQuestions({ pastedForm: text });
    remember(result.questions);
    return result.questions;
  }

  async function onDraft(questions: ApplicationQuestion[]) {
    remember(questions);
    const result = await draftAnswers({ jobId: id, questions });
    answersId.current = result.id;
    return result;
  }

  async function onRegenerate(questionId: string, mode: RegenerateMode): Promise<ApplicationAnswer> {
    void mode;
    const question = questionsById.current[questionId];
    if (!question) throw new Error(`Unknown question "${questionId}" — cannot regenerate without its prompt/kind.`);
    const result = await draftAnswers({ jobId: id, questions: [question] });
    const answer = result.answers.find((a) => a.questionId === questionId);
    if (!answer) throw new Error(`No drafted answer returned for question "${questionId}".`);
    return answer;
  }

  function onSaveAnswers(answers: ApplicationAnswer[]) {
    if (!answersId.current) return;
    void patchAnswers(answersId.current, answers).then(() => router.push(`/jobs/${id}`));
  }

  if (!loaded || !job) return null;

  if (!resume) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
        <div style={{ maxWidth: "var(--content-max, 960px)", margin: "0 auto" }}>
          <p style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
            Upload a résumé before drafting application answers. <Link href="/resume">Go to résumé upload</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 960px)", margin: "0 auto" }}>
        <ApplyQuestionsAssistant
          job={job}
          resume={resume}
          detected={detected}
          onExtract={onExtract}
          onDraft={onDraft}
          onRegenerate={onRegenerate}
          onSaveAnswers={onSaveAnswers}
        />
      </div>
    </div>
  );
}
