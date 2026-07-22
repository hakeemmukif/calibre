// ResumeStore (rich storage, LLM output) → frozen Resume (wire view).
// Spec 2026-07-22-resume-attributes-design.md §5: headline/location are
// derived best-effort and NULLABLE on the wire — null is explicit absence
// (the profile attribute layer prompts the user), never a default.
// ParseFailedError remains for genuinely unparseable documents (ingest.ts).
import { Resume } from "@/types";
import type { ResumeStore } from "./resume-store";

export class ParseFailedError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ParseFailedError";
    this.cause = options?.cause;
  }
}

const LOCATION_LABEL_RE = /location|city|based/i;
const HEADLINE_LABEL_RE = /headline|title|role/i;

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function deriveLocation(store: ResumeStore): string | null {
  if (store.location) return store.location;
  const fromContact = store.contact.find((c) => LOCATION_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  return store.experience[0]?.location ?? null;
}

export function deriveHeadline(store: ResumeStore): string | null {
  if (store.headline) return store.headline;
  const fromContact = store.contact.find((c) => HEADLINE_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  const fromExperience = store.experience[0]?.title;
  if (fromExperience) return fromExperience;
  const fromEducation = store.education[0];
  if (fromEducation) return fromEducation.credential ?? fromEducation.school;
  return null;
}

export function toResumeView(
  store: ResumeStore,
  opts: { id: string; atsScore: number; updatedAt: string; rawText: string },
): Resume {
  return Resume.parse({
    id: opts.id,
    atsScore: opts.atsScore,
    updatedAt: opts.updatedAt,
    headline: deriveHeadline(store),
    location: deriveLocation(store),
    summary: store.summary,
    experience: store.experience.map((e) => ({
      title: e.title,
      company: e.company,
      dates: e.dates,
      bullets: e.bullets,
    })),
    skills: dedupePreserveOrder(store.skills.flatMap((g) => g.items)),
    projects: store.projects,
    certifications: store.certifications,
    languages: store.languages,
    rawText: opts.rawText,
    extractionPath: store.extractionPath,
  });
}
