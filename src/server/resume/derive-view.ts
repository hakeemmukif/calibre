// ResumeStore (rich storage, LLM output) → frozen Resume (wire view).
// docs/architecture/system-architecture.md §1 reconciliation: headline/
// location are derived, never defaulted — an underivable field throws
// (fail-loud; no partial résumé view is ever returned).
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

function deriveLocation(store: ResumeStore): string {
  if (store.location) return store.location;
  const fromContact = store.contact.find((c) => LOCATION_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  const fromExperience = store.experience[0]?.location;
  if (fromExperience) return fromExperience;
  throw new ParseFailedError(
    "Could not derive a location from the résumé — no location field, no contact line matching location/city/based, and the most recent experience entry has none. Edit and re-submit with a location.",
  );
}

function deriveHeadline(store: ResumeStore): string {
  if (store.headline) return store.headline;
  const fromContact = store.contact.find((c) => HEADLINE_LABEL_RE.test(c.label))?.value;
  if (fromContact) return fromContact;
  const fromExperience = store.experience[0]?.title;
  if (fromExperience) return fromExperience;
  const fromEducation = store.education[0];
  if (fromEducation) return fromEducation.credential ?? fromEducation.school;
  throw new ParseFailedError(
    "Could not derive a headline from the résumé — no headline field, no contact line matches headline/title/role, no most-recent experience title, and no education entry. Edit and re-submit with a role.",
  );
}

// Validates the underivable-field rules without needing id/atsScore/updatedAt
// — lets ingest.ts fail loud before any side effect (file write / DB insert),
// even though toResumeView itself can only run once those are known.
export function assertResumeViewDerivable(store: ResumeStore): void {
  deriveHeadline(store);
  deriveLocation(store);
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
  });
}
