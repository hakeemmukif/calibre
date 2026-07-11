// Zod schema for the rich `ResumeStore` storage shape (schema.ts §1) — the
// single source of truth: this is both the LLM `resume-extract` json_schema
// (responseSchema) and the type schema.ts's `resumes.structured` column
// binds to. Mirrors schema.ts's shape exactly; does not change the DB
// column shape.
import { z } from "zod";

export const ContactLineSchema = z.object({ label: z.string(), value: z.string() });

export const ExperienceEntrySchema = z.object({
  company: z.string(),
  title: z.string(),
  dates: z.string(),
  bullets: z.array(z.string()),
  location: z.string().optional(),
});

export const EducationEntrySchema = z.object({
  school: z.string(),
  credential: z.string(),
  dates: z.string(),
});

export const SkillGroupSchema = z.object({ label: z.string(), items: z.array(z.string()) });

export const ResumeStoreSchema = z.object({
  name: z.string(),
  contact: z.array(ContactLineSchema),
  summary: z.string(),
  experience: z.array(ExperienceEntrySchema),
  education: z.array(EducationEntrySchema),
  skills: z.array(SkillGroupSchema),
  extras: z.array(z.string()),
});

export type ResumeStore = z.infer<typeof ResumeStoreSchema>;
