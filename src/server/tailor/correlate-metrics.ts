import { fuzzyContains } from "@/server/resume/eval-metrics";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { CorrelationRow, TailorDiffEntry } from "@/types";

export function flattenResumeText(store: ResumeStore): string {
  const parts: string[] = [store.name, store.headline ?? "", store.location ?? "", store.summary ?? ""];
  for (const e of store.experience) {
    parts.push(e.company, e.title, e.dates, e.location ?? "", ...e.bullets);
  }
  for (const p of store.projects) parts.push(p.name, ...p.bullets);
  for (const g of store.skills) parts.push(g.label ?? "", ...g.items);
  for (const ed of store.education) parts.push(ed.school, ed.credential ?? "", ed.dates ?? "", ...ed.details);
  for (const c of store.certifications) parts.push(c.name, c.issuer ?? "", c.year ?? "");
  for (const l of store.languages) parts.push(l.language, l.proficiency ?? "");
  for (const s of store.sections) parts.push(s.heading, ...s.items);
  return parts.filter(Boolean).join("\n");
}

// fuzzyContains("", s) is true iff s has no significant tokens (vacuous).
function isVacuous(s: string): boolean {
  return fuzzyContains("", s);
}

function matches(text: string, needle: string): boolean {
  if (isVacuous(needle)) {
    const t = needle.trim().toLowerCase();
    return t.length > 0 && text.toLowerCase().includes(t); // real check, never vacuous-true
  }
  return fuzzyContains(text, needle);
}

export function verifyEvidence(
  rows: Omit<CorrelationRow, "atsPresent">[],
  store: ResumeStore,
): CorrelationRow[] {
  const text = flattenResumeText(store);
  return rows.map((r) => {
    const atsPresent = matches(text, r.term);
    if (r.status === "met" || r.status === "buried") {
      const ok = r.evidence != null && r.evidence.trim() !== "" && matches(text, r.evidence);
      if (!ok) {
        return { ...r, status: "gap", evidence: null, atsPresent,
          reason: "evidence unverifiable — no matching résumé text",
          note: "evidence unverifiable — no matching résumé text" };
      }
    }
    if (r.status === "gap" && r.evidence != null) {
      return { ...r, evidence: null, atsPresent };
    }
    return { ...r, atsPresent };
  });
}

export function semanticSignal(rows: CorrelationRow[]) {
  const met = rows.filter((r) => r.status === "met").length;
  const buried = rows.filter((r) => r.status === "buried").length;
  const gap = rows.filter((r) => r.status === "gap").length;
  return { met, buried, gap, total: rows.length };
}

export function atsSignal(rows: CorrelationRow[]) {
  const present = rows.filter((r) => r.atsPresent).length;
  const missing = rows.filter((r) => !r.atsPresent).map((r) => r.term);
  return { present, total: rows.length, missing };
}

const NUMERIC_ATOM = /\d[\d,.]*%?/g; // 40, 40%, 1,200, 3.5, 2024

function numericAtoms(text: string): string[] {
  return (text.match(NUMERIC_ATOM) ?? []).map((s) => s.replace(/[,.]$/, ""));
}

export function fabricationViolations(edits: TailorDiffEntry[], store: ResumeStore): string[] {
  const baseNums = new Set(numericAtoms(flattenResumeText(store)));
  const violations: string[] = [];
  for (const e of edits) {
    if (!e.after) continue;
    for (const atom of numericAtoms(e.after)) {
      if (!baseNums.has(atom)) {
        violations.push(
          `edit for "${e.requirement}" introduces number "${atom}" absent from the base résumé`);
      }
    }
  }
  return violations;
}
