"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Tag } from "../../components/Tag";
import { QuestionIntake, type IntakeMode } from "./QuestionIntake";
import { QuestionListEditor } from "./QuestionListEditor";
import { AnswerCard, type AnswerDraftStatus, type QuestionSource, type RegenerateMode } from "./AnswerCard";
import { ResumeRail } from "./ResumeRail";
import type { GroundingItem } from "./GroundingChips";
import type { Job, Resume, ApplicationQuestion, ApplicationAnswer } from "../../../types";
import { answers as answersFixture } from "../../fixtures";

export interface ApplyQuestionsAssistantProps {
  job: Job;
  resume: Resume;
  detected?: ApplicationQuestion[];
  onSaveAnswers(answers: ApplicationAnswer[]): void;
}

type Phase = "intake" | "review" | "answers";

interface Draft {
  answer: ApplicationAnswer;
  status: AnswerDraftStatus;
}

let nextId = 1;

// draftAnswerFor — the stand-in for POST /api/apply/answers (an LLM call in
// production). Deterministic: reuses the job-grab-backend fixture answer
// when the question matches one of the seeded ids, otherwise synthesizes a
// résumé-grounded draft from `resume.summary` + the most recent bullet.
// Boolean questions (e.g. work authorization) aren't backed by résumé text,
// so they draft with empty grounding — the real "not found in résumé"
// signal, per the api-contract's empty-grounding-array convention.
function draftAnswerFor(question: ApplicationQuestion, resume: Resume, seeded?: ApplicationAnswer): ApplicationAnswer {
  if (seeded) return seeded;
  if (question.kind === "boolean") {
    return { questionId: question.id, prompt: question.prompt, answer: "Yes", grounding: [] };
  }
  const bullet = resume.experience[0]?.bullets[0];
  const text = `${resume.summary} ${bullet ? `For example: ${bullet}` : ""}`.trim();
  const clipped = question.maxLength ? text.slice(0, question.maxLength) : text;
  return {
    questionId: question.id,
    prompt: question.prompt,
    answer: clipped,
    grounding: [
      { source: "summary", quote: resume.summary },
      ...(bullet ? ([{ source: "experience" as const, quote: bullet }]) : []),
    ],
  };
}

function regenerateText(base: string, mode: RegenerateMode, resume: Resume): string {
  if (mode === "shorter") return base.slice(0, Math.max(40, Math.floor(base.length * 0.6))).trim();
  if (mode === "more-formal") return `I would like to note that ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  return `${base} Specifically, ${resume.experience[0]?.bullets[0]?.toLowerCase() || "this drew directly on my recent work"}.`;
}

// ApplyQuestionsAssistant — F4 in full (§2): intake → extract → review
// questions → draft → edit/copy, with a résumé side-rail grounding chips
// scroll to. Renders as a full page from JobDetail's "Answer questions"
// launch, not a modal.
export function ApplyQuestionsAssistant({ job, resume, detected, onSaveAnswers }: ApplyQuestionsAssistantProps) {
  const [phase, setPhase] = React.useState<Phase>(detected && detected.length > 0 ? "review" : "intake");
  const [intakeMode, setIntakeMode] = React.useState<IntakeMode>("detected");
  const [questions, setQuestions] = React.useState<ApplicationQuestion[]>(detected ?? []);
  const [sources, setSources] = React.useState<Record<string, QuestionSource>>(
    Object.fromEntries((detected ?? []).map((q) => [q.id, "ats-detected" as const])),
  );
  const [extracting, setExtracting] = React.useState(false);
  const [extractError, setExtractError] = React.useState<string | undefined>();
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [draftingAll, setDraftingAll] = React.useState(false);
  const [railOpen, setRailOpen] = React.useState(false);
  const [railActive, setRailActive] = React.useState<GroundingItem | undefined>();

  function handleExtract(mode: IntakeMode, text?: string) {
    const wordCount = (text || "").trim().split(/\s+/).filter(Boolean).length;
    setExtracting(true);
    setExtractError(undefined);
    window.setTimeout(() => {
      setExtracting(false);
      if (wordCount < 5 || (text || "").toLowerCase().includes("no questions")) {
        setExtractError("Couldn't find any questions in that text — try Paste JD, or add them manually.");
        return;
      }
      const source: QuestionSource = mode === "paste-jd" ? "jd-inferred" : "pasted-form";
      const parsed = [
        { id: `q-${nextId++}`, prompt: "Why do you want to work here?", kind: "textarea" as const, required: true, maxLength: 600 },
        { id: `q-${nextId++}`, prompt: "Describe relevant experience for this role.", kind: "textarea" as const, required: true, maxLength: 800 },
        { id: `q-${nextId++}`, prompt: "Are you authorized to work in this location?", kind: "boolean" as const, required: true },
      ];
      setQuestions(parsed);
      setSources(Object.fromEntries(parsed.map((q) => [q.id, source])));
      setPhase("review");
    }, 700);
  }

  function handleManualAdd() {
    setQuestions([]);
    setSources({});
    setExtractError(undefined);
    setPhase("review");
  }

  function handleEditQuestion(id: string, patch: Partial<ApplicationQuestion>) {
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  function handleDeleteQuestion(id: string) {
    setQuestions((qs) => qs.filter((q) => q.id !== id));
    setSources((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  }

  function handleAddQuestion() {
    const id = `q-manual-${nextId++}`;
    setQuestions((qs) => [...qs, { id, prompt: "New question", kind: "text", required: false }]);
  }

  function handleDraftAll() {
    setDraftingAll(true);
    setPhase("answers");
    setDrafts(Object.fromEntries(questions.map((q) => [q.id, { answer: { questionId: q.id, prompt: q.prompt, answer: "", grounding: [] }, status: "drafting" as const }])));
    questions.forEach((q, i) => {
      window.setTimeout(() => {
        // Reuse the seeded fixture answer verbatim when this job/question
        // matches the pre-baked answers.json (job-grab-backend's q1–q3);
        // otherwise synthesize a fresh draft from the résumé.
        const seeded = job.id === answersFixture.jobId ? answersFixture.answers.find((a) => a.questionId === q.id) : undefined;
        const answer = draftAnswerFor(q, resume, seeded);
        setDrafts((d) => ({ ...d, [q.id]: { answer, status: "ready" } }));
        if (i === questions.length - 1) setDraftingAll(false);
      }, 500 + i * 450);
    });
  }

  function handleChangeText(id: string, text: string) {
    setDrafts((d) => ({ ...d, [id]: { answer: { ...d[id].answer, answer: text }, status: "edited" } }));
  }

  function handleRegenerate(id: string, mode: RegenerateMode) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], status: "drafting" } }));
    window.setTimeout(() => {
      setDrafts((d) => ({
        ...d,
        [id]: { answer: { ...d[id].answer, answer: regenerateText(d[id].answer.answer, mode, resume) }, status: "ready" },
      }));
    }, 450);
  }

  function handleCopy(id: string) {
    const text = drafts[id]?.answer.answer || "";
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function handleCopyAll() {
    const text = questions.map((q) => `${q.prompt}\n${drafts[q.id]?.answer.answer || ""}`).join("\n\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function handleSelectGrounding(item: GroundingItem) {
    setRailActive(item);
    setRailOpen(true);
  }

  const allReady = questions.length > 0 && questions.every((q) => drafts[q.id]?.status === "ready" || drafts[q.id]?.status === "edited");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 16 }}>
        <span style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>
          Answer application questions — {job.company} · {job.role}
        </span>
      </div>

      {phase === "intake" && (
        <QuestionIntake
          mode={intakeMode}
          onModeChange={setIntakeMode}
          detected={detected}
          onExtract={handleExtract}
          extracting={extracting}
          error={extractError}
          onManualAdd={handleManualAdd}
        />
      )}

      {phase === "review" && (
        <QuestionListEditor
          questions={questions}
          sources={sources}
          onEdit={handleEditQuestion}
          onDelete={handleDeleteQuestion}
          onAdd={handleAddQuestion}
          onDraftAll={handleDraftAll}
          drafting={draftingAll}
        />
      )}

      {phase === "answers" && (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
            {questions.map((q) => {
              const draft = drafts[q.id];
              if (!draft) return null;
              return (
                <AnswerCard
                  key={q.id}
                  question={q}
                  answer={draft.answer}
                  resume={resume}
                  status={draft.status}
                  source={sources[q.id]}
                  onChangeText={(text) => handleChangeText(q.id, text)}
                  onRegenerate={(mode) => handleRegenerate(q.id, mode)}
                  onCopy={() => handleCopy(q.id)}
                  onSelectGrounding={handleSelectGrounding}
                  selectedGrounding={railActive}
                />
              );
            })}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              {allReady ? <Tag tone="good">All answers drafted</Tag> : <span />}
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="secondary" iconLeft="copy" onClick={handleCopyAll}>Copy all</Button>
                <Button
                  variant="primary"
                  iconLeft="check"
                  disabled={!allReady}
                  onClick={() => onSaveAnswers(questions.map((q) => drafts[q.id]?.answer).filter(Boolean) as ApplicationAnswer[])}
                >
                  Save answers
                </Button>
              </div>
            </div>
          </div>

          <ResumeRail resume={resume} open={railOpen} onToggle={() => setRailOpen((o) => !o)} active={railActive} />
        </div>
      )}
    </div>
  );
}
