import { fuzzyContains } from "@/server/resume/eval-metrics";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { CorrelationRow } from "@/types";

export function flattenResumeText(store: ResumeStore): string {
  const parts: string[] = [store.name, store.headline ?? "", store.location ?? "", store.summary ?? ""];
  for (const e of store.experience) {
    parts.push(e.company, e.title, ...e.bullets);
  }
  for (const p of store.projects) parts.push(p.name, ...p.bullets);
  for (const g of store.skills) parts.push(g.label ?? "", ...g.items);
  for (const ed of store.education) parts.push(ed.school, ed.credential ?? "", ...ed.details);
  for (const c of store.certifications) parts.push(c.name);
  for (const l of store.languages) parts.push(l.language);
  for (const s of store.sections) parts.push(s.heading, ...s.items);
  return parts.filter(Boolean).join("\n");
}

export function verifyEvidence(
  rows: Omit<CorrelationRow, "atsPresent">[],
  store: ResumeStore,
): CorrelationRow[] {
  const text = flattenResumeText(store);
  return rows.map((r) => {
    const atsPresent = fuzzyContains(text, r.term);
    if (r.status === "met" || r.status === "buried") {
      const ok = r.evidence != null && r.evidence.trim() !== "" && fuzzyContains(text, r.evidence);
      if (!ok) {
        return { ...r, status: "gap", evidence: null, atsPresent,
          note: "evidence unverifiable — no matching résumé text" };
      }
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
