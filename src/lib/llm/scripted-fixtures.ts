// Canonical scripted LLM fixtures — the "Jane Doe, Senior Backend Engineer,
// Payments" universe used by src/app/spine.test.ts and (Task 2.3) the E2E
// test-profile seam via getLlm. Leaf module: only imports the TaskName type.
import type { TaskName } from "./client";

// The mock "resume-extract" task response — validated against
// ResumeStoreEmitSchema (every field required, scalars nullable), same as
// the real LLM call now wired in server/resume/ingest.ts. Flows through
// emitToStore() before it reaches any consumer.
export const RESUME_STORE = {
  storeVersion: 2,
  name: "Jane Doe",
  headline: null,
  location: null,
  summary: "Backend engineer with six years of experience building payments systems.",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  experience: [
    {
      company: "Acme Co",
      title: "Senior Backend Engineer",
      dates: "2022–Present",
      start: "2022-01",
      end: null,
      location: null,
      bullets: ["Led migration to Kubernetes"],
    },
  ],
  education: [],
  skills: [{ label: "Domain", items: ["Payments", "TypeScript"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

// The mock "resume-extract-vision" task response — same EMIT shape as
// RESUME_STORE above (ResumeStoreEmitSchema), for the image-only/near-
// textless PDF routing path (server/resume/ingest.ts). Flows through
// emitToStore(_, "vision") before it reaches any consumer.
export const RESUME_STORE_VISION = {
  storeVersion: 2,
  name: "Jane Doe",
  headline: null,
  location: null,
  summary: "Backend engineer with six years of experience building payments systems.",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  experience: [
    {
      company: "Acme Co",
      title: "Senior Backend Engineer",
      dates: "2022–Present",
      start: "2022-01",
      end: null,
      location: null,
      bullets: ["Led migration to Kubernetes"],
    },
  ],
  education: [],
  skills: [{ label: "Domain", items: ["Payments", "TypeScript"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

export const JD_FACTS = {
  title: "Senior Backend Engineer, Payments",
  isJobPosting: true,
  company: "Acme Payments",
  seniority: null,
  employmentType: null,
  location: null,
  remotePolicy: null,
  hiringScope: null,
  hiringCountries: null,
  salaryRange: null,
  mustHaves: ["Node.js", "Postgres"],
  niceToHaves: ["Kafka"],
  responsibilities: ["Own the payments ledger service"],
  redFlags: [],
  tzRequirement: null,
  hiringStructure: null,
  workCalendar: null,
};

export const URL_SEARCH_RESULT = {
  found: false,
  content: "",
  sourceNote: "No independent corroboration found for this posting.",
};

export const GHOST_WEB_EVIDENCE = {
  sightings: [
    { url: "https://boards.greenhouse.io/acme/jobs/999001", source: "Greenhouse", postedDate: "2026-06-01" },
  ],
  companySignals: ["Careers page lists the role."],
  summary: "Seen once on the company's Greenhouse board within the last two months; nothing else to report.",
  confidence: 0.6,
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

// The mock "tailor" task response — its `resume` field validates against
// ResumeStoreEmitSchema (every field required, scalars nullable), same as
// RESUME_STORE above (TailorResultSchema, server/tailor/index.ts). Flows
// through emitToStore() before it reaches any consumer.
const TAILORED_RESUME_EMIT = {
  storeVersion: 2 as const,
  name: "Jane Doe",
  headline: null,
  location: null,
  summary: "Backend engineer specializing in payments infrastructure.",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  experience: [
    {
      company: "Acme Co",
      title: "Senior Backend Engineer",
      dates: "2022–Present",
      start: "2022-01",
      end: null,
      location: null,
      bullets: ["Led migration to Kubernetes"],
    },
  ],
  education: [],
  skills: [{ label: "Domain", items: ["Payments", "TypeScript"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

export const TAILOR_RESULT = {
  resume: TAILORED_RESUME_EMIT,
  diff: [
    {
      section: "summary",
      op: "modify" as const,
      before: RESUME_STORE.summary,
      after: TAILORED_RESUME_EMIT.summary,
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
  "resume-extract-vision": RESUME_STORE_VISION,
  "jd-extract": JD_FACTS,
  "url-check-search": URL_SEARCH_RESULT,
  "ghost-web": GHOST_WEB_EVIDENCE,
  "match-score": MATCH_SCORE,
  "question-extract": QUESTION_EXTRACT,
  "question-answer": QUESTION_ANSWER,
  tailor: TAILOR_RESULT,
};
