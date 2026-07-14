// Deterministic 0–100 ATS-completeness heuristic — no LLM. Four
// independently-capped signals (max 100 when all are saturated):
//   summary completeness  (0–20): length-banded (empty/short/medium/long)
//   experience substance   (0–40): 10 pts per entry with ≥1 bullet, up to 4
//   skills breadth         (0–25): 1 pt per distinct skill item, up to 25
//   contact completeness   (0–15): 3 pts per non-empty contact line, up to 15
import type { ResumeStore } from "./resume-store";

export function computeAtsScore(store: ResumeStore): number {
  const summaryLength = (store.summary ?? "").trim().length;
  const summaryScore = summaryLength >= 80 ? 20 : summaryLength >= 40 ? 12 : summaryLength > 0 ? 6 : 0;

  const experienceScore = Math.min(store.experience.filter((e) => e.bullets.length > 0).length, 4) * 10;

  const skillItemCount = store.skills.reduce((n, g) => n + g.items.length, 0);
  const skillsScore = Math.min(skillItemCount, 25);

  const contactLineCount = store.contact.filter((c) => c.value.trim().length > 0).length;
  const contactScore = Math.min(contactLineCount * 3, 15);

  return Math.min(100, summaryScore + experienceScore + skillsScore + contactScore);
}
