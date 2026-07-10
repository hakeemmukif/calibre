"use client";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Chip } from "../../components/Chip";
import { Tag } from "../../components/Tag";
import type { ApplicationQuestion } from "../../../types";
import type { QuestionSource } from "./AnswerCard";

const KIND_OPTIONS: ApplicationQuestion["kind"][] = ["text", "textarea", "select", "multiselect", "boolean", "file"];

export interface QuestionListEditorProps {
  questions: ApplicationQuestion[];
  sources?: Record<string, QuestionSource>;
  onEdit(id: string, patch: Partial<ApplicationQuestion>): void;
  onDelete(id: string): void;
  onAdd(): void;
  onDraftAll(): void;
  drafting?: boolean;
}

const SOURCE_LABEL: Record<QuestionSource, string> = {
  "ats-detected": "detected",
  "pasted-form": "pasted",
  "jd-inferred": "inferred",
};

// QuestionListEditor — the editable review step between extraction and
// drafting: delete a mis-parse, edit prompt/kind/char-limit, or add one
// manually, then "Draft all answers". `sources` is local UI provenance per
// question (which intake tab produced it) — ApplicationQuestion itself
// carries no such field in the frozen contract, so it's tracked alongside,
// not on the entity.
export function QuestionListEditor({ questions, sources, onEdit, onDelete, onAdd, onDraftAll, drafting }: QuestionListEditorProps) {
  return (
    <Card padding="lg">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {questions.map((q, i) => {
          const source = sources?.[q.id];
          return (
            <div key={q.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderBottom: i < questions.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", flex: "none", paddingTop: 10 }}>
                Q{i + 1}
              </span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  value={q.prompt}
                  onChange={(e) => onEdit(q.id, { prompt: e.target.value })}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    font: "600 14px/1.35 var(--font-body)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                  }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select
                    value={q.kind}
                    onChange={(e) => onEdit(q.id, { kind: e.target.value as ApplicationQuestion["kind"] })}
                    style={{ padding: "5px 8px", font: "var(--type-caption)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)" }}
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  {(q.kind === "text" || q.kind === "textarea") && (
                    <input
                      type="number"
                      value={q.maxLength ?? ""}
                      placeholder="max chars"
                      onChange={(e) => onEdit(q.id, { maxLength: e.target.value ? Number(e.target.value) : undefined })}
                      style={{ width: 92, padding: "5px 8px", font: "var(--type-caption)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)" }}
                    />
                  )}
                  {source && <Tag tone={source === "jd-inferred" ? "warn" : "neutral"}>{SOURCE_LABEL[source]}</Tag>}
                  {q.required && <Tag tone="neutral">required</Tag>}
                </div>
              </div>
              <IconButton icon="trash-2" label="Delete question" onClick={() => onDelete(q.id)} />
            </div>
          );
        })}

        <Chip dashed iconLeft="plus" onClick={onAdd} style={{ alignSelf: "flex-start" }}>
          Add question
        </Chip>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Button variant="soft-accent" iconLeft="sparkles" disabled={drafting || questions.length === 0} onClick={onDraftAll}>
          {drafting ? "Drafting…" : "Draft all answers"}
        </Button>
      </div>
    </Card>
  );
}
