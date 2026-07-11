// FormField[] -> ApplicationQuestion[] (task-B7-brief.md "locked interfaces").
// FormField is the connector.ts shape (server/search/connector.ts) shared by
// all three extraction tiers; this module owns the one kind-mapping table
// every tier funnels through, so tier-specific vocabularies (donor DOM-parse
// field_type strings, Greenhouse's `?questions=true` field types, and the
// question-extract template's own vocabulary) never fork into separate logic.
import { ApplicationQuestion } from "@/types";
import type { FormField } from "../search/connector";

// Never silently defaults an unrecognized field_type to a guessed kind (the
// same fail-loud rule extract-questions.ts applies to "no questions found").
// "unknown" IS a recognized value (the donor DOM-parser's own honest
// "couldn't tell" signal) and maps to "text" — the widest, safest editable
// kind — rather than being dropped.
const KIND_BY_FIELD_TYPE: Record<string, ApplicationQuestion["kind"]> = {
  // Generic aliases (task-B7-brief.md's own example table).
  input: "text",
  text: "text",
  dropdown: "select",
  "single-select": "select",
  select: "select",
  multi: "multiselect",
  multiselect: "multiselect",
  "multi-select": "multiselect",
  "yes-no": "boolean",
  yes_no: "boolean",
  boolean: "boolean",
  attachment: "file",
  file: "file",
  textarea: "textarea",
  // Tier 2 — donor DOM-parse vocabulary (careerops-web/src/lib/apply-form.ts
  // RawFieldType), rebuilt clean in ./dom-parse.ts.
  radio: "select",
  checkbox: "boolean",
  number: "text",
  unknown: "text",
  // Tier 1 — Greenhouse `?questions=true` field types. TODO-verify-live: this
  // vocabulary is documented but not confirmed against a live board in this
  // task (task-B7-brief.md "Escalate if" — implemented behind this mapping
  // rather than fabricated as confirmed; tier 3 is the tested guarantee).
  input_text: "text",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
};

function stableId(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `q-${index}-${slug}` : `q-${index}`;
}

export function mapFields(fields: FormField[]): ApplicationQuestion[] {
  return fields.map((field, index) => {
    const kind = KIND_BY_FIELD_TYPE[field.field_type];
    if (!kind) {
      throw new Error(
        `map-fields: unrecognized field_type "${field.field_type}" for question "${field.label}" — cannot map to a frozen ApplicationQuestion.kind.`,
      );
    }

    const isChoiceKind = kind === "select" || kind === "multiselect";

    return ApplicationQuestion.parse({
      id: stableId(field.label, index),
      prompt: field.label,
      kind,
      ...(isChoiceKind ? { options: field.options ?? [] } : {}),
      required: field.required,
      ...(field.limit !== undefined ? { maxLength: field.limit } : {}),
    });
  });
}
