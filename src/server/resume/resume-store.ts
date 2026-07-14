// v2 ResumeStore — the single contract feeding ATS scoring, match-scoring,
// tailoring, derive-view, and the apply-assistant. Two schemas + one
// normalizer, the pattern src/server/score/jdFacts.ts proves: the EMIT
// schema (every field required, scalars nullable) unlocks strict:true
// constrained decoding and forces the model to interrogate every concept;
// emitToStore() deterministically normalizes it into the STORE schema the
// DB jsonb column and every consumer bind to.
import { z } from "zod";

export const ContactLineSchema = z.object({ label: z.string(), value: z.string() });

export const ExperienceEntrySchema = z.object({
  company: z.string(),
  title: z.string(),
  dates: z.string(),
  start: z.string().optional(), // "YYYY-MM" atom, normalized
  end: z.string().optional(), // "YYYY-MM" atom; absent = ongoing OR unparseable — resolve via isCurrent
  isCurrent: z.boolean(),
  location: z.string().optional(),
  bullets: z.array(z.string()),
});

export const EducationEntrySchema = z.object({
  school: z.string(),
  credential: z.string().optional(),
  dates: z.string().optional(),
  details: z.array(z.string()),
});

export const SkillGroupSchema = z.object({ label: z.string().optional(), items: z.array(z.string()) });
export const ProjectSchema = z.object({ name: z.string(), url: z.string().optional(), bullets: z.array(z.string()) });
export const CertificationSchema = z.object({ name: z.string(), issuer: z.string().optional(), year: z.string().optional() });
export const LanguageEntrySchema = z.object({ language: z.string(), proficiency: z.string().optional() });
export const ExtraSectionSchema = z.object({ heading: z.string(), items: z.array(z.string()) });

export const ResumeStoreSchema = z.object({
  storeVersion: z.literal(2),
  extractionPath: z.enum(["text", "vision"]),
  name: z.string(),
  headline: z.string().optional(),
  location: z.string().optional(),
  summary: z.string().optional(),
  contact: z.array(ContactLineSchema),
  experience: z.array(ExperienceEntrySchema),
  education: z.array(EducationEntrySchema),
  skills: z.array(SkillGroupSchema),
  projects: z.array(ProjectSchema),
  certifications: z.array(CertificationSchema),
  languages: z.array(LanguageEntrySchema),
  sections: z.array(ExtraSectionSchema),
});
export type ResumeStore = z.infer<typeof ResumeStoreSchema>;

// EMIT schema (LLM json_schema, strict:true): every field required. Nullable
// audit (Fable): a required NON-nullable scalar on a frequently-absent
// concept invites fabrication — so every legitimately-absent scalar is
// nullable; only `name` is required-non-null. `extractionPath` is NOT emitted
// (the caller stamps it); `isCurrent` is derived by emitToStore, not emitted.
const ExperienceEmitSchema = z.object({
  company: z.string(),
  title: z.string(),
  dates: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  location: z.string().nullable(),
  bullets: z.array(z.string()),
});
const EducationEmitSchema = z.object({
  school: z.string(),
  credential: z.string().nullable(),
  dates: z.string().nullable(),
  details: z.array(z.string()),
});
const SkillGroupEmitSchema = z.object({ label: z.string().nullable(), items: z.array(z.string()) });
const ProjectEmitSchema = z.object({ name: z.string(), url: z.string().nullable(), bullets: z.array(z.string()) });
const CertificationEmitSchema = z.object({ name: z.string(), issuer: z.string().nullable(), year: z.string().nullable() });
const LanguageEmitSchema = z.object({ language: z.string(), proficiency: z.string().nullable() });

export const ResumeStoreEmitSchema = z.object({
  storeVersion: z.literal(2),
  name: z.string(),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
  contact: z.array(ContactLineSchema),
  experience: z.array(ExperienceEmitSchema),
  education: z.array(EducationEmitSchema),
  skills: z.array(SkillGroupEmitSchema),
  projects: z.array(ProjectEmitSchema),
  certifications: z.array(CertificationEmitSchema),
  languages: z.array(LanguageEmitSchema),
  sections: z.array(ExtraSectionSchema),
});
export type ResumeStoreEmit = z.infer<typeof ResumeStoreEmitSchema>;

const CURRENT_RE = /present|current|now|ongoing/i;
const YYYY_MM_RE = /^\d{4}-\d{2}$/;

// Coerce an LLM-emitted date atom to a strict "YYYY-MM" or undefined. NEVER
// throws — a single malformed atom is a normalized miss (availability), not a
// whole-extraction crash (Global Constraints exception).
function coerceMonth(atom: string | null): string | undefined {
  if (atom === null) return undefined;
  const trimmed = atom.trim();
  return YYYY_MM_RE.test(trimmed) ? trimmed : undefined;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

const clean = (v: string | null): string | undefined => {
  if (v === null) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

export function emitToStore(emit: ResumeStoreEmit, extractionPath: "text" | "vision"): ResumeStore {
  const store: ResumeStore = {
    storeVersion: 2,
    extractionPath,
    name: emit.name.trim(),
    headline: clean(emit.headline),
    location: clean(emit.location),
    summary: clean(emit.summary),
    contact: emit.contact.map((c) => ({ label: c.label.trim(), value: c.value.trim() })).filter((c) => c.value.length > 0),
    experience: emit.experience.map((e) => ({
      company: e.company.trim(),
      title: e.title.trim(),
      dates: (e.dates ?? "").trim(),
      start: coerceMonth(e.start),
      end: coerceMonth(e.end),
      isCurrent: CURRENT_RE.test(e.dates ?? ""),
      location: clean(e.location),
      bullets: e.bullets.map((b) => b.trim()).filter(Boolean),
    })),
    education: emit.education.map((ed) => ({
      school: ed.school.trim(),
      credential: clean(ed.credential),
      dates: clean(ed.dates),
      details: ed.details.map((d) => d.trim()).filter(Boolean),
    })),
    skills: emit.skills.map((g) => ({ label: clean(g.label), items: dedupe(g.items) })).filter((g) => g.items.length > 0),
    projects: emit.projects.map((p) => ({ name: p.name.trim(), url: clean(p.url), bullets: p.bullets.map((b) => b.trim()).filter(Boolean) })),
    certifications: emit.certifications.map((c) => ({ name: c.name.trim(), issuer: clean(c.issuer), year: clean(c.year) })),
    languages: emit.languages.map((l) => ({ language: l.language.trim(), proficiency: clean(l.proficiency) })),
    sections: emit.sections.map((s) => ({ heading: s.heading.trim(), items: s.items.map((i) => i.trim()).filter(Boolean) })).filter((s) => s.items.length > 0),
  };
  return ResumeStoreSchema.parse(store);
}
