// Canonical scripted LLM fixtures — the "Jane Doe, Senior Backend Engineer,
// Payments" universe used by src/app/spine.test.ts and (Task 2.3) the E2E
// test-profile seam via getLlm. Leaf module: only imports the TaskName type.
import type { TaskName } from "./client";

export const RESUME_STORE = {
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  summary: "Backend engineer with six years of experience building payments systems.",
  experience: [
    { company: "Acme Co", title: "Senior Backend Engineer", dates: "2022–Present", bullets: ["Led migration to Kubernetes"] },
  ],
  education: [],
  skills: [{ label: "Domain", items: ["Payments", "TypeScript"] }],
  extras: [],
};

export const JD_FACTS = {
  title: "Senior Backend Engineer, Payments",
  mustHaves: ["Node.js", "Postgres"],
  niceToHaves: ["Kafka"],
  responsibilities: ["Own the payments ledger service"],
  redFlags: [],
};

export const MATCH_SCORE = {
  score: 4.2,
  verdict: "Apply" as const,
  why: "Strong overlap with recent backend/payments experience.",
  breakdown: [{ label: "Skills match", value: 85, display: "85%", tone: "good" as const }],
  fit: [{ k: "Stack", v: "Node.js, Postgres" }],
  gaps: [],
  reasons: { for: ["Payments experience"], against: [] },
  legitimacy: { tier: "clear" as const, summary: "Looks like a normal listing.", signals: [], corroborated: false },
  lowConfidence: false,
};

export const TAILOR_RESULT = {
  resume: { ...RESUME_STORE, summary: "Backend engineer specializing in payments infrastructure." },
  diff: [
    {
      section: "summary",
      op: "modify" as const,
      before: RESUME_STORE.summary,
      after: "Backend engineer specializing in payments infrastructure.",
      reason: "Ties the summary to the payments domain named in the posting.",
    },
  ],
};

export const QUESTION_EXTRACT = {
  questions: [{ id: "q1", prompt: "Why do you want to work here?", kind: "textarea", required: true }],
};

export const QUESTION_ANSWER = {
  answers: [
    {
      questionId: "q1",
      prompt: "Why do you want to work here?",
      answer: "Because of the payments-scale challenge.",
      grounding: [{ source: "summary", quote: RESUME_STORE.summary }],
    },
  ],
};

// Keyed by TaskName so makeMockLlm(scriptedFixtures) answers every F1-F6 call.
export const scriptedFixtures: Partial<Record<TaskName, unknown>> = {
  "resume-extract": RESUME_STORE,
  "jd-extract": JD_FACTS,
  "match-score": MATCH_SCORE,
  "question-extract": QUESTION_EXTRACT,
  "question-answer": QUESTION_ANSWER,
  tailor: TAILOR_RESULT,
};
