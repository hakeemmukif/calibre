import { describe, expect, it } from "vitest";
import type { FormField } from "../search/connector";
import { mapFields } from "./map-fields";

describe("mapFields", () => {
  it("maps each frozen kind from its field_type", () => {
    const fields: FormField[] = [
      { label: "Full name", field_type: "text", required: true },
      { label: "Cover letter", field_type: "textarea", required: false, limit: 500 },
      { label: "How did you hear about us?", field_type: "select", required: true, options: ["LinkedIn", "Referral"] },
      { label: "Languages spoken", field_type: "multiselect", required: false, options: ["English", "Malay"] },
      { label: "Are you authorized to work?", field_type: "boolean", required: true },
      { label: "Resume", field_type: "file", required: true },
    ];
    const questions = mapFields(fields);
    expect(questions.map((q) => q.kind)).toEqual(["text", "textarea", "select", "multiselect", "boolean", "file"]);
  });

  it("carries options only for select/multiselect kinds", () => {
    const [textQ, selectQ] = mapFields([
      { label: "Name", field_type: "text", required: true, options: ["should be dropped"] },
      { label: "Team", field_type: "select", required: true, options: ["A", "B"] },
    ]);
    expect(textQ.options).toBeUndefined();
    expect(selectQ.options).toEqual(["A", "B"]);
  });

  it("defaults options to [] for a (multi)select field with none supplied", () => {
    const [q] = mapFields([{ label: "Team", field_type: "select", required: true }]);
    expect(q.options).toEqual([]);
  });

  it("maps limit to maxLength", () => {
    const [q] = mapFields([{ label: "Bio", field_type: "textarea", required: false, limit: 250 }]);
    expect(q.maxLength).toBe(250);
  });

  it("omits maxLength when no limit is given", () => {
    const [q] = mapFields([{ label: "Bio", field_type: "textarea", required: false }]);
    expect(q.maxLength).toBeUndefined();
  });

  it("assigns stable, distinct ids derived from the label", () => {
    const [q1, q2] = mapFields([
      { label: "Full Name", field_type: "text", required: true },
      { label: "Full Name", field_type: "text", required: false },
    ]);
    expect(q1.id).not.toBe(q2.id);
  });

  it("passes through donor DOM-tier field types (radio/checkbox/number/unknown)", () => {
    const questions = mapFields([
      { label: "Preferred contact", field_type: "radio", required: true, options: ["Email", "Phone"] },
      { label: "Agree to terms", field_type: "checkbox", required: true },
      { label: "Years of experience", field_type: "number", required: false },
      { label: "Mystery field", field_type: "unknown", required: false },
    ]);
    expect(questions.map((q) => q.kind)).toEqual(["select", "boolean", "text", "text"]);
  });

  it("passes through Greenhouse tier-1 field types (TODO-verify-live vocabulary)", () => {
    const questions = mapFields([
      { label: "Cover letter", field_type: "input_text", required: false },
      { label: "Referral source", field_type: "multi_value_single_select", required: false, options: ["LinkedIn"] },
      { label: "Languages", field_type: "multi_value_multi_select", required: false, options: ["English"] },
    ]);
    expect(questions.map((q) => q.kind)).toEqual(["text", "select", "multiselect"]);
  });

  it("throws on an unrecognized field_type rather than guessing (never silently dropped/defaulted)", () => {
    expect(() => mapFields([{ label: "Mystery", field_type: "totally-unknown-type", required: false }])).toThrow(
      /unrecognized field_type/,
    );
  });
});
