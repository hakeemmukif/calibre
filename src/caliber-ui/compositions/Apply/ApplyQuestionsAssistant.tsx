"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Tag } from "../../components/Tag";
import { QuestionIntake, type IntakeMode } from "./QuestionIntake";
import { QuestionListEditor } from "./QuestionListEditor";
import { AnswerCard, type AnswerDraftStatus, type QuestionSource, type RegenerateMode } from "./AnswerCard";
import { ResumeRail } from "./ResumeRail";
import type { GroundingItem } from "./GroundingChips";
import type { Job, Resume, ApplicationQuestion, ApplicationAnswer, ApplicationAnswers } from "../../../types";

export interface ApplyQuestionsAssistantProps {
  job: Job;
  resume: Resume;
  detected?: ApplicationQuestion[];
  /** POST /api/apply/questions — extract questions from pasted form/JD text. */
  onExtract(mode: IntakeMode, text: string): Promise<ApplicationQuestion[]>;
  /** POST /api/apply/answers — draft résumé-grounded answers for all questions. */
  onDraft(questions: ApplicationQuestion[]): Promise<ApplicationAnswers>;
  /** A targeted re-draft of a single answer (PATCH /api/apply/answers/:id in effect). */
  onRegenerate(questionId: string, mode: RegenerateMode): Promise<ApplicationAnswer>;
  onSaveAnswers(answers: ApplicationAnswer[]): void;
}

type Phase = "intake" | "review" | "answers";

interface Draft {
  answer: ApplicationAnswer;
  status: AnswerDraftStatus;
}

let nextId = 1;

// ApplyQuestionsAssistant — F4 in full (§2): intake → extract → review
// questions → draft → edit/copy, with a résumé side-rail grounding chips
// scroll to. Renders as a full page from JobDetail's "Answer questions"
// launch, not a modal.
export function ApplyQuestionsAssistant({ job, resume, detected, onExtract, onDraft, onRegenerate, onSaveAnswers }: ApplyQuestionsAssistantProps) {
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

  async function handleExtract(mode: IntakeMode, text?: string) {
    setExtracting(true);
    setExtractError(undefined);
    try {
      const parsed = await onExtract(mode, text ?? "");
      const source: QuestionSource = mode === "paste-jd" ? "jd-inferred" : "pasted-form";
      setQuestions(parsed);
      setSources(Object.fromEntries(parsed.map((q) => [q.id, source])));
      setPhase("review");
    } catch (err) {
      setExtractError(
        err instanceof Error ? err.message : "Couldn't find any questions in that text — try Paste JD, or add them manually.",
      );
    } finally {
      setExtracting(false);
    }
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

  async function handleDraftAll() {
    setDraftingAll(true);
    setPhase("answers");
    setDrafts(Object.fromEntries(questions.map((q) => [q.id, { answer: { questionId: q.id, prompt: q.prompt, answer: "", grounding: [] }, status: "drafting" as const }])));
    try {
      const result = await onDraft(questions);
      const byId = new Map(result.answers.map((a) => [a.questionId, a]));
      setDrafts(
        Object.fromEntries(
          questions.map((q) => {
            const answer = byId.get(q.id);
            return [
              q.id,
              answer
                ? { answer, status: "ready" as const }
                : { answer: { questionId: q.id, prompt: q.prompt, answer: "", grounding: [] }, status: "error" as const },
            ];
          }),
        ),
      );
    } catch {
      setDrafts((d) =>
        Object.fromEntries(
          questions.map((q) => [q.id, { answer: d[q.id]?.answer ?? { questionId: q.id, prompt: q.prompt, answer: "", grounding: [] }, status: "error" as const }]),
        ),
      );
    } finally {
      setDraftingAll(false);
    }
  }

  function handleChangeText(id: string, text: string) {
    setDrafts((d) => ({ ...d, [id]: { answer: { ...d[id].answer, answer: text }, status: "edited" } }));
  }

  async function handleRegenerate(id: string, mode: RegenerateMode) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], status: "drafting" } }));
    try {
      const answer = await onRegenerate(id, mode);
      setDrafts((d) => ({ ...d, [id]: { answer, status: "ready" } }));
    } catch {
      setDrafts((d) => ({ ...d, [id]: { ...d[id], status: "error" } }));
    }
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
