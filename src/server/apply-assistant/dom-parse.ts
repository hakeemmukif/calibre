// Tier 2 — headless fetch + DOM parse (system-architecture.md §5). Rebuilds
// donor `extractFieldsInPage`/`snapshotGreenhouseForm`
// (careerops-web/src/lib/apply-form.ts) clean and generalizes the container
// selectors beyond Greenhouse-only, since this tier is the fallback for any
// remote-ATS posting once tier 1 (structured API) doesn't apply.
//
// Never spawned in unit tests: extractQuestions imports `parseFormViaDom`
// from this module by name, and extract-questions.test.ts replaces the whole
// module with `vi.mock("./dom-parse", ...)` — no Chromium launch happens in
// CI. Login-gated boards (JobStreet/Hiredly) and bot walls are an EXPECTED
// failure mode here, not a bug: any error (navigation failure, no form
// found) is swallowed to `null` so the caller can fall through to the
// 502 EXTRACTION_FAILED path instead of crashing the request.
import { chromium } from "playwright";
import type { FormField } from "../search/connector";

type RawFieldType = "text" | "textarea" | "select" | "radio" | "checkbox" | "number" | "file" | "unknown";

interface RawField {
  label: string;
  field_type: RawFieldType;
  required: "yes" | "no" | "unknown";
  limit?: string;
  options?: string[];
}

// Runs inside page.evaluate() — pure DOM reads, no mutation, no interaction,
// no closures over anything outside the page (Playwright serializes this
// function into the page context).
function extractFieldsInPage(): RawField[] {
  const root =
    document.querySelector("#application_form") ??
    document.querySelector(".application--form") ??
    document.querySelector("form") ??
    document.body;
  if (!root) return [];

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function stripRequiredMarker(text: string): string {
    return text
      .replace(/[*✱]\s*$/g, "")
      .replace(/\(required\)/gi, "")
      .replace(/\(optional\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
      const byFor = document.querySelector(`label[for="${escaped}"]`);
      if (byFor?.textContent) return stripRequiredMarker(byFor.textContent);
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel?.textContent) return stripRequiredMarker(wrappingLabel.textContent);
    const container = el.closest("div, li, fieldset");
    const containerLabel = container?.querySelector("label");
    if (containerLabel?.textContent) return stripRequiredMarker(containerLabel.textContent);
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return stripRequiredMarker(ariaLabel);
    return "";
  }

  function isRequired(el: Element): "yes" | "no" | "unknown" {
    if (el.hasAttribute("required")) return "yes";
    const ariaRequired = el.getAttribute("aria-required");
    if (ariaRequired === "true") return "yes";
    if (ariaRequired === "false") return "no";
    const id = el.getAttribute("id");
    let rawLabelText = "";
    if (id) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
      rawLabelText = document.querySelector(`label[for="${escaped}"]`)?.textContent ?? "";
    }
    if (!rawLabelText) {
      rawLabelText = el.closest("label")?.textContent ?? el.closest("div, li, fieldset")?.querySelector("label")?.textContent ?? "";
    }
    if (/[*✱]\s*$/.test(rawLabelText.trim())) return "yes";
    if (/\(optional\)/i.test(rawLabelText)) return "no";
    return "unknown";
  }

  function mapInputType(el: HTMLInputElement): RawFieldType {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (type === "number") return "number";
    if (type === "file") return "file";
    if (type === "text" || type === "email" || type === "tel" || type === "url" || type === "search") return "text";
    return "unknown";
  }

  const seenRadioGroups = new Set<string>();
  const fields: RawField[] = [];

  const controls = Array.from(root.querySelectorAll("input, textarea, select"));
  for (const control of controls) {
    if (!isVisible(control)) continue;
    const tag = control.tagName.toLowerCase();

    if (tag === "input") {
      const input = control as HTMLInputElement;
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") continue;

      if (type === "radio") {
        const name = input.getAttribute("name");
        const groupKey = name || labelFor(input);
        if (name && seenRadioGroups.has(groupKey)) continue;
        if (name) seenRadioGroups.add(groupKey);

        const group = name
          ? Array.from(root.querySelectorAll(`input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`)).filter((el) => isVisible(el))
          : [input];
        const options = group.map((el) => labelFor(el)).map((t) => t.trim()).filter((t) => t.length > 0);
        const fieldset = input.closest("fieldset");
        const legend = fieldset?.querySelector("legend")?.textContent;
        const groupLabel = legend ? stripRequiredMarker(legend) : labelFor(input);

        fields.push({
          label: groupLabel,
          field_type: "radio",
          required: isRequired(input),
          options: options.length > 0 ? options : undefined,
        });
        continue;
      }

      if (type === "checkbox") {
        fields.push({ label: labelFor(input), field_type: "checkbox", required: isRequired(input) });
        continue;
      }

      const label = labelFor(input);
      const maxlength = input.getAttribute("maxlength");
      fields.push({
        label,
        field_type: mapInputType(input),
        required: isRequired(input),
        limit: maxlength && maxlength.trim().length > 0 ? maxlength.trim() : undefined,
      });
      continue;
    }

    if (tag === "textarea") {
      const textarea = control as HTMLTextAreaElement;
      const label = labelFor(textarea);
      const maxlength = textarea.getAttribute("maxlength");
      fields.push({
        label,
        field_type: "textarea",
        required: isRequired(textarea),
        limit: maxlength && maxlength.trim().length > 0 ? maxlength.trim() : undefined,
      });
      continue;
    }

    if (tag === "select") {
      const select = control as HTMLSelectElement;
      const label = labelFor(select);
      const options = Array.from(select.querySelectorAll("option"))
        .map((opt) => opt.textContent?.trim() ?? "")
        .filter((text) => text.length > 0 && !/^(select|choose|--|please select)/i.test(text));
      fields.push({
        label,
        field_type: "select",
        required: isRequired(select),
        options: options.length > 0 ? options : undefined,
      });
      continue;
    }
  }

  return fields;
}

function toFormField(raw: RawField): FormField {
  return {
    label: raw.label,
    field_type: raw.field_type,
    // No tri-state "unknown" on our FormField.required (boolean) — collapse
    // both "no" and the honest "unknown" case to false (least-presumptuous:
    // never claim a field is required without a provable signal).
    required: raw.required === "yes",
    ...(raw.limit ? { limit: Number(raw.limit) } : {}),
    ...(raw.options ? { options: raw.options } : {}),
  };
}

export async function parseFormViaDom(url: string): Promise<FormField[] | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2_000);
      const raw = await page.evaluate(extractFieldsInPage);
      if (raw.length === 0) return null;
      return raw.map(toFormField);
    } finally {
      await page.close();
    }
  } catch {
    // Expected failure mode (system-architecture.md §5): bot walls, login
    // gates, or a posting with no application form. Tolerated here so
    // extractQuestions can fall through to 502 EXTRACTION_FAILED rather than
    // crash the request.
    return null;
  } finally {
    await browser?.close();
  }
}
