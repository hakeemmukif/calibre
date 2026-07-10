"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Tag } from "../../components/Tag";
import { Icon } from "../../components/Icon";
import { Chip } from "../../components/Chip";
import { Select } from "../../components/Select";
import { Textarea } from "../../components/Textarea";
import { GroundingChips, type GroundingItem } from "./GroundingChips";
import type { ApplicationQuestion, ApplicationAnswer, Resume } from "../../../types";

export type AnswerDraftStatus = "drafting" | "ready" | "edited" | "error";
export type RegenerateMode = "shorter" | "more-formal" | "more-specific";
export type QuestionSource = "ats-detected" | "pasted-form" | "jd-inferred";

const KIND_LABEL: Record<ApplicationQuestion["kind"], string> = {
  text: "short",
  textarea: "long",
  select: "select",
  multiselect: "multi-select",
  boolean: "yes/no",
  file: "file",
};

export interface AnswerCardProps {
  question: ApplicationQuestion;
  answer: ApplicationAnswer;
  resume: Resume;
  status: AnswerDraftStatus;
  /** Provenance of the question this answer belongs to — drives the "inferred" Tag. */
  source?: QuestionSource;
  onChangeText(text: string): void;
  onRegenerate(mode: RegenerateMode): void;
  onCopy(): void;
  onSelectGrounding(item: GroundingItem): void;
  onRetry?(): void;
  selectedGrounding?: GroundingItem;
}

const REGENERATE_OPTIONS: { mode: RegenerateMode; label: string }[] = [
  { mode: "shorter", label: "Shorter" },
  { mode: "more-formal", label: "More formal" },
  { mode: "more-specific", label: "More specific" },
];

// AnswerCard — one drafted answer: editable textarea seeded with the LLM
// draft, live char counter vs `question.maxLength`, GroundingChips, and
// per-card Regenerate (dropdown) + Copy. `select`/`multiselect`/`boolean`
// question kinds render their native control instead of free text — the
// answer is still just `ApplicationAnswer.answer` (a string), so no new
// contract field is needed to carry the choice.
export function AnswerCard({
  question,
  answer,
  resume,
  status,
  source,
  onChangeText,
  onRegenerate,
  onCopy,
  onSelectGrounding,
  onRetry,
  selectedGrounding,
}: AnswerCardProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  const constraint =
    question.maxLength != null ? `${KIND_LABEL[question.kind]} · ≤${question.maxLength}` : KIND_LABEL[question.kind];

  return (
    <Card padding="lg" style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ font: "var(--type-h3)", color: "var(--text-strong)", flex: 1, minWidth: 200 }}>
          {question.prompt}
        </span>
        <Tag tone="neutral">{constraint}</Tag>
        {source === "jd-inferred" && <Tag tone="warn">inferred</Tag>}
        {status === "error" && <Tag tone="danger">draft failed</Tag>}
      </div>

      {status === "drafting" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: 12,
                width: i === 2 ? "60%" : "100%",
                borderRadius: 4,
                background: "var(--surface-sunken)",
                animation: "caliber-pulse 1.1s ease-in-out infinite alternate",
              }}
            />
          ))}
          <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>Drafting from your résumé…</span>
        </div>
      )}

      {status === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "6px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--danger-ink)" }}>
            <Icon name="triangle-alert" size={16} />
            <span style={{ font: "var(--type-body)" }}>Couldn't draft this answer.</span>
          </div>
          {onRetry && (
            <Button variant="secondary" iconLeft="refresh-cw" onClick={onRetry} style={{ alignSelf: "flex-start" }}>
              Retry
            </Button>
          )}
        </div>
      )}

      {(status === "ready" || status === "edited") && question.kind === "boolean" && (
        <div style={{ display: "flex", gap: 8, padding: "4px 0" }}>
          {["Yes", "No"].map((opt) => (
            <Button
              key={opt}
              variant={answer.answer === opt ? "primary" : "secondary"}
              onClick={() => onChangeText(opt)}
            >
              {opt}
            </Button>
          ))}
        </div>
      )}

      {(status === "ready" || status === "edited") && question.kind === "select" && (
        <Select
          value={answer.answer}
          onChange={(e) => onChangeText(e.target.value)}
          options={[{ value: "", label: "Choose an option…" }, ...(question.options || []).map((o) => ({ value: o, label: o }))]}
        />
      )}

      {(status === "ready" || status === "edited") && question.kind === "multiselect" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(question.options || []).map((o) => {
            const selectedValues = answer.answer.split(",").map((s) => s.trim()).filter(Boolean);
            const isSelected = selectedValues.includes(o);
            return (
              <Chip
                key={o}
                selected={isSelected}
                iconLeft={isSelected ? "check" : undefined}
                onClick={() => {
                  const next = isSelected ? selectedValues.filter((v) => v !== o) : [...selectedValues, o];
                  onChangeText(next.join(", "));
                }}
              >
                {o}
              </Chip>
            );
          })}
        </div>
      )}

      {(status === "ready" || status === "edited") && question.kind === "file" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface-sunken)",
            color: "var(--text-muted)",
          }}
        >
          <Icon name="file-text" size={16} />
          <span style={{ font: "var(--type-body)" }}>
            This question requires a file upload — attach it directly in the ATS; Caliber doesn't submit files on your behalf.
          </span>
        </div>
      )}

      {(status === "ready" || status === "edited") && (question.kind === "text" || question.kind === "textarea") && (
        <div>
          <Textarea
            value={answer.answer}
            onChange={(e) => onChangeText(e.target.value)}
            rows={question.kind === "textarea" ? 5 : 2}
          />
          {question.maxLength != null && (
            <div
              style={{
                textAlign: "right",
                font: "var(--type-caption)",
                color: answer.answer.length > question.maxLength ? "var(--danger-ink)" : "var(--text-muted)",
                marginTop: 4,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {answer.answer.length}/{question.maxLength}
            </div>
          )}
        </div>
      )}

      {(status === "ready" || status === "edited") && (
        <>
          <div style={{ marginTop: 12 }}>
            <GroundingChips grounding={answer.grounding} resume={resume} onSelect={onSelectGrounding} selected={selectedGrounding} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <div style={{ position: "relative" }}>
              <Button variant="secondary" iconRight="chevron-down" onClick={() => setMenuOpen((o) => !o)}>
                Regenerate
              </Button>
              {menuOpen && (
                <Card
                  padding="sm"
                  style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 10, minWidth: 160 }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {REGENERATE_OPTIONS.map((o) => (
                      <Button
                        key={o.mode}
                        variant="ghost"
                        style={{ justifyContent: "flex-start" }}
                        onClick={() => {
                          onRegenerate(o.mode);
                          setMenuOpen(false);
                        }}
                      >
                        {o.label}
                      </Button>
                    ))}
                  </div>
                </Card>
              )}
            </div>
            <Button variant={copied ? "soft-accent" : "secondary"} iconLeft="copy" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
