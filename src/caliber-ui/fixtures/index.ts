// Caliber fixtures — realistic sample data for every Storybook story.
// Every export is Schema.parse(...)-validated at module load: a contract
// mismatch throws here, at import time, not silently in a story. Never
// lorem — real remote/Malaysia job-search content.
import { z } from "zod";
import {
  Job,
  Resume,
  Application,
  ApplicationQuestion,
  ApplicationAnswers,
  TailoredResume,
} from "../../types";
import { legitimacyTone } from "../lib/legitimacy";

// ---------------------------------------------------------------------------
// Jobs — all 5 legitimacy tiers, both personas, isNew mix, one `ghost: true`.
// ---------------------------------------------------------------------------

const rawJobs = [
  {
    id: "job-grab-backend",
    score: 4.6,
    role: "Senior Backend Engineer, Payments",
    company: "Grab",
    meta: "Remote · APAC · RM 14,000–18,000/mo",
    verdict: "Strong fit — verified employer, direct ATS listing",
    why: "6 yrs Node.js and distributed-systems experience line up with the payments team's stack; posted directly on Grab's own Greenhouse, no agency markup.",
    tags: [
      { tone: "good", label: "Strong fit" },
      { tone: "verified", label: "Direct ATS" },
    ],
    breakdown: [
      { label: "Skills match", value: 88, display: "88%", tone: "good" },
      { label: "Seniority match", value: 92, display: "92%", tone: "good" },
      { label: "Comp alignment", value: 75, display: "75%", tone: "warn" },
    ],
    fit: [
      { k: "Stack", v: "Node.js, Kafka, Postgres" },
      { k: "Level", v: "Senior (6+ yrs)" },
    ],
    gaps: [
      { tone: "warn", k: "Kubernetes", v: "listed as nice-to-have, not on résumé" },
      { tone: "ok", k: "Payments domain", v: "2 yrs at a previous fintech" },
    ],
    legitimacy: {
      tier: "verified",
      tone: legitimacyTone("verified"),
      summary: "Posted directly on Grab's Greenhouse ATS; company careers page cross-checked.",
      confidence: 0.97,
    },
    applyUrl: "https://job-boards.greenhouse.io/grab/jobs/6041234",
    source: { id: "src-greenhouse-grab", name: "Grab Careers (Greenhouse)", kind: "ats", persona: "remote" },
    persona: "remote",
    firstSeen: "2026-07-10T09:15:00Z",
    isNew: true,
  },
  {
    id: "job-xendit-pm",
    score: 2.3,
    role: "Product Manager, Payments Infrastructure",
    company: "Xendit",
    meta: "Remote · Indonesia/SEA · Comp undisclosed",
    verdict: "Legitimate employer, weak role fit",
    why: "A well-run payments company, but the role is product management — the résumé's engineering depth doesn't map cleanly onto it.",
    tags: [{ tone: "good", label: "Legit employer" }],
    breakdown: [
      { label: "Skills match", value: 38, display: "38%", tone: "warn" },
      { label: "Seniority match", value: 70, display: "70%", tone: "good" },
      { label: "Comp alignment", value: 50, display: "50%", tone: "warn" },
    ],
    fit: [
      { k: "Function", v: "Product, not engineering" },
      { k: "Domain", v: "Payments infra (adjacent)" },
    ],
    gaps: [{ tone: "warn", k: "PM track record", v: "no shipped PM roles on résumé" }],
    legitimacy: {
      tier: "clear",
      tone: legitimacyTone("clear"),
      summary: "Verified via Lever and the company's LinkedIn page; standard hiring pattern for a funded fintech.",
      confidence: 0.9,
    },
    applyUrl: "https://jobs.lever.co/xendit/pm-payments-infra",
    source: { id: "src-lever-xendit", name: "Xendit Careers (Lever)", kind: "ats", persona: "remote" },
    persona: "remote",
    firstSeen: "2026-06-28T04:00:00Z",
    isNew: false,
  },
  {
    id: "job-carsome-growth",
    score: 1.8,
    role: "Growth Marketing Executive",
    company: "Carsome",
    meta: "Kuala Lumpur, Malaysia · Hybrid · RM 3,500–4,000/mo",
    verdict: "Proceed with caution — reposted 4th time in 90 days",
    why: "Same listing reposted quarterly with identical text; comp sits below Carsome's public bands; a marketing role is also a weak match for an engineering résumé.",
    tags: [{ tone: "warn", label: "Reposted" }],
    breakdown: [
      { label: "Skills match", value: 12, display: "12%", tone: "warn" },
      { label: "Seniority match", value: 40, display: "40%", tone: "warn" },
    ],
    fit: [{ k: "Function", v: "Growth marketing (unrelated)" }],
    gaps: [{ tone: "warn", k: "Marketing background", v: "none on résumé" }],
    legitimacy: {
      tier: "suspicious",
      tone: legitimacyTone("suspicious"),
      summary:
        "Reposted 4 times since April with identical text; may be an evergreen pipeline-builder rather than a real open seat.",
      confidence: 0.62,
    },
    applyUrl: "https://www.jobstreet.com.my/job/carsome-growth-marketing-executive-991234",
    source: { id: "src-jobstreet", name: "JobStreet Malaysia", kind: "board", persona: "local" },
    persona: "local",
    firstSeen: "2026-04-12T02:00:00Z",
    isNew: false,
  },
  {
    id: "job-meridian-ghost",
    score: 2.9,
    ghost: true,
    role: "APAC Solutions Engineer (Remote)",
    company: "Meridian Cloud Systems",
    meta: "Remote · APAC · Comp undisclosed",
    verdict: "Likely a ghost listing — open 214 days, no hiring activity",
    why: "Live for over 7 months across three job boards with no company page and generic boilerplate JD — the fit numbers look fine, but no one is behind this.",
    tags: [{ tone: "ghost", label: "Stale posting" }],
    breakdown: [
      { label: "Skills match", value: 64, display: "64%", tone: "warn" },
      { label: "Seniority match", value: 58, display: "58%", tone: "warn" },
    ],
    fit: [{ k: "Days live", v: "214" }],
    gaps: [{ tone: "warn", k: "Company presence", v: "no LinkedIn page beyond the listing" }],
    legitimacy: {
      tier: "ghost",
      tone: legitimacyTone("ghost"),
      summary:
        "Open 214 days with zero verifiable hires and no LinkedIn presence beyond the listing — likely evergreen pipeline-building, not an active req.",
      confidence: 0.71,
    },
    applyUrl: "https://www.linkedin.com/jobs/view/3841122333",
    source: { id: "src-linkedin", name: "LinkedIn Jobs", kind: "board", persona: "remote" },
    persona: "remote",
    firstSeen: "2025-12-08T02:00:00Z",
    isNew: false,
  },
  {
    id: "job-wfh-scam",
    score: 0.4,
    role: "Data Entry Clerk — Work From Home",
    company: "GlobalLink Ventures",
    meta: "Work from home · Malaysia · RM 8,000–12,000/mo · no experience needed",
    verdict: "Do not apply — matches a known scam pattern",
    why: "Unrealistic pay for the stated skill level, WhatsApp-only contact, and an upfront 'starter kit' deposit — the same pattern PDRM's CCID flagged in Q1 2026 job-scam advisories.",
    tags: [{ tone: "danger", label: "Scam pattern" }],
    breakdown: [{ label: "Skills match", value: 8, display: "8%", tone: "warn" }],
    fit: [{ k: "Requested deposit", v: "RM 350 'device fee'" }],
    gaps: [{ tone: "warn", k: "Registered company", v: "no SSM registration found" }],
    legitimacy: {
      tier: "scam",
      tone: legitimacyTone("scam"),
      summary:
        "Classic Malaysian job-scam pattern: WhatsApp-only recruiter, no registered company found, requests an upfront 'device deposit' before starting.",
      confidence: 0.94,
    },
    applyUrl: "https://wa.me/60123456789",
    source: { id: "src-facebook-jobs", name: "Facebook Jobs", kind: "board", persona: "local" },
    persona: "local",
    firstSeen: "2026-07-09T11:30:00Z",
    isNew: true,
  },
  {
    id: "job-petronas-data",
    score: 4.3,
    role: "Data Engineer, Digital & Technology",
    company: "PETRONAS Digital",
    meta: "Kuala Lumpur, Malaysia · Hybrid · RM 9,000–12,000/mo",
    verdict: "Strong fit — verified employer, direct careers page",
    why: "SQL/Python/ETL background matches the data platform team's stack; posted directly on the corporate careers site, recruiter verified on LinkedIn.",
    tags: [
      { tone: "good", label: "Strong fit" },
      { tone: "verified", label: "Direct careers page" },
    ],
    breakdown: [
      { label: "Skills match", value: 81, display: "81%", tone: "good" },
      { label: "Seniority match", value: 85, display: "85%", tone: "good" },
    ],
    fit: [{ k: "Stack", v: "Python, Airflow, Postgres" }],
    gaps: [{ tone: "ok", k: "Domain", v: "energy-sector data experience is a plus, not required" }],
    legitimacy: {
      tier: "verified",
      tone: legitimacyTone("verified"),
      summary:
        "Posted on PETRONAS Digital & Technology's official careers site; recruiter identity verified via LinkedIn.",
      confidence: 0.95,
    },
    applyUrl: "https://careers.petronas.com/job/data-engineer-digital-tech",
    source: { id: "src-petronas-careers", name: "PETRONAS Careers", kind: "board", persona: "local" },
    persona: "local",
    firstSeen: "2026-06-20T03:00:00Z",
    isNew: false,
  },
] satisfies z.input<typeof Job>[];

export const jobs: Job[] = Job.array().parse(rawJobs);

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export const resume: Resume = Resume.parse({
  id: "resume-1",
  atsScore: 78,
  updatedAt: "2026-07-05T10:00:00Z",
  headline: "Senior Backend Engineer · Payments & Distributed Systems",
  location: "Kuala Lumpur, Malaysia · open to remote (APAC/SEA)",
  summary:
    "Backend engineer with 6 years building payments and ledger systems at scale. Led the migration of a settlement pipeline from batch to event-driven (Kafka), cutting reconciliation time from 6 hours to 4 minutes. Comfortable owning a service end to end: schema, API, on-call.",
  experience: [
    {
      title: "Senior Backend Engineer",
      company: "Fave (SEA fintech)",
      dates: "2023–2026",
      bullets: [
        "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min.",
        "Owned the payments ledger service (Node.js/TypeScript), processing ~2M transactions/day.",
        "Mentored 2 junior engineers; ran the on-call rotation for the payments squad.",
      ],
    },
    {
      title: "Backend Engineer",
      company: "iPay88",
      dates: "2020–2023",
      bullets: [
        "Built the merchant onboarding API used by 3,000+ SMEs.",
        "Migrated a monolith billing module into a standalone service with zero downtime.",
      ],
    },
  ],
  skills: ["Node.js", "TypeScript", "Kafka", "PostgreSQL", "AWS", "Docker", "REST APIs", "System design"],
  rawText:
    "Senior Backend Engineer with 6 years building payments and ledger systems...\n\nExperience\nFave (SEA fintech) — Senior Backend Engineer, 2023–2026\n- Rebuilt merchant settlement pipeline on Kafka + Postgres...\n\niPay88 — Backend Engineer, 2020–2023\n- Built merchant onboarding API used by 3,000+ SMEs...\n\nSkills: Node.js, TypeScript, Kafka, PostgreSQL, AWS, Docker, REST APIs, System design",
});

// ---------------------------------------------------------------------------
// Applications (tracker rows)
// ---------------------------------------------------------------------------

export const applications: Application[] = Application.array().parse([
  {
    id: "app-1",
    jobId: "job-grab-backend",
    role: "Senior Backend Engineer, Payments",
    company: "Grab",
    meta: "Remote · APAC",
    appliedAt: "2026-07-08T06:00:00Z",
    score: 4.6,
    stage: 1,
    statusLabel: "Screening",
    statusTone: "good",
    tailored: true,
    note: "Recruiter screen scheduled for Jul 15.",
    tailoredResumeId: "tailored-1",
    answersId: "answers-1",
  },
  {
    id: "app-2",
    jobId: "job-petronas-data",
    role: "Data Engineer, Digital & Technology",
    company: "PETRONAS Digital",
    meta: "Kuala Lumpur · Hybrid",
    appliedAt: "2026-06-22T02:00:00Z",
    score: 4.3,
    stage: 0,
    statusLabel: "Applied",
    statusTone: "verified",
    tailored: false,
    note: "",
    tailoredResumeId: null,
    answersId: null,
  },
  {
    id: "app-3",
    jobId: "job-xendit-pm",
    role: "Product Manager, Payments Infrastructure",
    company: "Xendit",
    meta: "Remote · SEA",
    appliedAt: "2026-06-29T08:00:00Z",
    score: 2.3,
    stage: 3,
    statusLabel: "Not selected",
    statusTone: "neutral",
    tailored: false,
    note: "Rejected after recruiter screen — role fit mismatch as flagged.",
    tailoredResumeId: null,
    answersId: null,
  },
]);

// ---------------------------------------------------------------------------
// Application questions + answers (F4)
// ---------------------------------------------------------------------------

export const questions: ApplicationQuestion[] = ApplicationQuestion.array().parse([
  {
    id: "q1",
    prompt: "Why do you want to work at Grab?",
    kind: "textarea",
    required: true,
    maxLength: 600,
  },
  {
    id: "q2",
    prompt: "Describe a time you scaled a system under load.",
    kind: "textarea",
    required: true,
    maxLength: 800,
  },
  {
    id: "q3",
    prompt: "Are you authorized to work in Malaysia or Singapore?",
    kind: "boolean",
    required: true,
  },
]);

export const answers: ApplicationAnswers = ApplicationAnswers.parse({
  id: "answers-1",
  jobId: "job-grab-backend",
  resumeId: "resume-1",
  model: "openrouter/deepseek-v3.1",
  createdAt: "2026-07-08T05:50:00Z",
  answers: [
    {
      questionId: "q1",
      prompt: "Why do you want to work at Grab?",
      answer:
        "Grab's payments platform operates at a scale and reliability bar I've spent the last three years building toward — I rebuilt Fave's settlement pipeline onto Kafka to cut reconciliation from 6 hours to 4 minutes, and I want to bring that event-driven discipline to a team processing this volume.",
      grounding: [
        { source: "experience", quote: "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min." },
      ],
    },
    {
      questionId: "q2",
      prompt: "Describe a time you scaled a system under load.",
      answer:
        "At Fave, our payments ledger service was hitting ~2M transactions/day and starting to lag under peak-hour load. I split the batch reconciliation job into an event-driven Kafka pipeline, which brought reconciliation time down from 6 hours to under 4 minutes and removed a recurring on-call fire.",
      grounding: [
        { source: "experience", quote: "Owned the payments ledger service (Node.js/TypeScript), processing ~2M transactions/day." },
        { source: "experience", quote: "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min." },
      ],
    },
    {
      questionId: "q3",
      prompt: "Are you authorized to work in Malaysia or Singapore?",
      answer: "Yes — Malaysian citizen, based in Kuala Lumpur.",
      grounding: [],
    },
  ],
});

// ---------------------------------------------------------------------------
// Tailored résumé (F6)
// ---------------------------------------------------------------------------

export const tailored: TailoredResume = TailoredResume.parse({
  id: "tailored-1",
  jobId: "job-grab-backend",
  resumeId: "resume-1",
  status: "completed",
  progress: null,
  model: "openrouter/deepseek-v3.1",
  createdAt: "2026-07-08T05:40:00Z",
  completedAt: "2026-07-08T05:41:30Z",
  resume: {
    atsScore: 85,
    updatedAt: "2026-07-08T05:41:30Z",
    headline: "Senior Backend Engineer · Payments, Kafka & Distributed Ledgers",
    location: "Kuala Lumpur, Malaysia · open to remote (APAC/SEA)",
    summary:
      "Backend engineer with 6 years building high-throughput payments and ledger systems. Rebuilt a settlement pipeline on Kafka, cutting reconciliation from 6h to 4min at ~2M transactions/day — the same event-driven discipline Grab's payments platform runs on.",
    experience: [
      {
        title: "Senior Backend Engineer",
        company: "Fave (SEA fintech)",
        dates: "2023–2026",
        bullets: [
          "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min at ~2M transactions/day.",
          "Owned the payments ledger service (Node.js/TypeScript) end to end: schema, API, and on-call.",
          "Mentored 2 junior engineers on the payments squad.",
        ],
      },
      {
        title: "Backend Engineer",
        company: "iPay88",
        dates: "2020–2023",
        bullets: [
          "Built the merchant onboarding API used by 3,000+ SMEs.",
          "Migrated a monolith billing module into a standalone service with zero downtime.",
        ],
      },
    ],
    skills: ["Node.js", "TypeScript", "Kafka", "PostgreSQL", "AWS", "Docker", "REST APIs", "System design"],
  },
  diff: [
    {
      section: "Headline",
      op: "modify",
      before: "Senior Backend Engineer · Payments & Distributed Systems",
      after: "Senior Backend Engineer · Payments, Kafka & Distributed Ledgers",
      reason: "Surfaces Kafka explicitly — it's named in Grab's job description.",
    },
    {
      section: "Summary",
      op: "modify",
      before: "Comfortable owning a service end to end: schema, API, on-call.",
      after: "the same event-driven discipline Grab's payments platform runs on.",
      reason: "Ties the reconciliation win directly to Grab's stated stack.",
    },
    {
      section: "Experience · Fave",
      op: "modify",
      before: "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min.",
      after:
        "Rebuilt the merchant settlement pipeline on Kafka + Postgres, reducing reconciliation latency from 6h to 4min at ~2M transactions/day.",
      reason: "Adds the throughput number so it reads at Grab's scale, not just the time saved.",
    },
  ],
});
