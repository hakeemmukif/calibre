// Verdict-wrong feedback link (pre-launch hardening Task 7, Decision 1 —
// Telegram). Telegram does NOT support prefilled text to a personal account
// (the wa.me-style ?text= capability was removed) — t.me/share/url prefills
// BOTH fields and the user taps once to pick the operator (see
// OPERATOR_TELEGRAM_HANDLE in ./support.ts) from their chat list. The text
// covers both fit and legitimacy; no description — URL-length safe.
// Graduates to a verdict_feedback table when reports get lost or at public
// launch.
import type { Job } from "../../types";

export function buildVerdictFeedbackUrl(job: Job): string {
  const context = [
    "Caliber verdict feedback",
    `Job: ${job.role} — ${job.company}`,
    `Fit: ${job.score.toFixed(1)}/5 · Legitimacy: ${job.legitimacy.tier}`,
    `Job id: ${job.id}`,
    "What looks wrong:",
  ].join("\n");
  return `https://t.me/share/url?url=${encodeURIComponent(job.applyUrl)}&text=${encodeURIComponent(context)}`;
}
