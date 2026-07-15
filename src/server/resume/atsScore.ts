// Deterministic 0–100 ATS-completeness heuristic — no LLM. Six
// independently-capped signals (max 100 when all are saturated):
//   summary completeness    (0–16): length-banded (empty/short/medium/long)
//   experience substance    (0–28): 7 pts per entry with ≥1 bullet, up to 4
//   skills breadth          (0–20): 1 pt per distinct skill item, up to 20
//   contact completeness    (0–12): 3 pts per non-empty contact line, up to 12
//   quantified bullets      (0–16): quantifiedBulletRatio (resume-metrics) * 16
//   cert/language presence  (0–8): 4 pts for ≥1 certification, 4 for ≥1 language
import type { ResumeStore } from "./resume-store";
import { computeQuantifiedBulletRatio } from "./resume-metrics";

export function computeAtsScore(store: ResumeStore): number {
  const summaryLength = (store.summary ?? "").trim().length;
  const summaryScore = summaryLength >= 80 ? 16 : summaryLength >= 40 ? 10 : summaryLength > 0 ? 4 : 0;

  const experienceScore = Math.min(store.experience.filter((e) => e.bullets.length > 0).length, 4) * 7;

  const skillItemCount = store.skills.reduce((n, g) => n + g.items.length, 0);
  const skillsScore = Math.min(skillItemCount, 20);

  const contactLineCount = store.contact.filter((c) => c.value.trim().length > 0).length;
  const contactScore = Math.min(contactLineCount * 3, 12);

  const quantifiedScore = Math.round(computeQuantifiedBulletRatio(store) * 16);

  const certLangScore = (store.certifications.length > 0 ? 4 : 0) + (store.languages.length > 0 ? 4 : 0);

  return Math.min(100, summaryScore + experienceScore + skillsScore + contactScore + quantifiedScore + certLangScore);
}
