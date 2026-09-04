// Deterministic résumé metrics — no LLM. Fed by the start/end/isCurrent
// atoms resume-store.ts normalizes. Many real résumés (live-confirmed on
// the year-only sample) carry year-only date ranges with no month atoms, so
// duration derivation falls back to parsing the verbatim `dates` string at
// year granularity (Jan convention) — never fabricated back into the
// stored atoms, this parsing lives only here.
import type { ResumeStore } from "./resume-store";

export interface ResumeMetrics {
  totalYearsExperience: number;
  currentTenureMonths: number;
  roleCount: number;
  durationDerivedRoleCount: number;
  avgTenureMonths: number;
  distinctSkillCount: number;
  certificationCount: number;
  languageCount: number;
  quantifiedBulletRatio: number;
}

type ExperienceEntry = ResumeStore["experience"][number];
type Interval = { start: number; end: number };

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const ONGOING_RE = /\b(present|current|now|ongoing)\b/i;
const QUANTIFIED_RE = /\d|[%$€£¥]/;

function atomToMonthIndex(atom: string): number {
  const [year, month] = atom.split("-").map(Number);
  return year * 12 + (month - 1);
}

function nowMonthIndex(now: Date): number {
  return now.getFullYear() * 12 + now.getMonth();
}

// Year-only fallback: parses the verbatim `dates` string at Jan-of-year
// granularity. Only reached when the normalized start/end atoms don't fully
// resolve a role's duration. Extracts every 4-digit year in the string
// (regardless of separator — dash, "to", month names, "Since") rather than
// requiring a specific dash-adjacent shape, so "2018 to 2022", "Jun 2020 –
// Aug 2022", and "Since 2019" all resolve alongside the dash cases. The
// entry's own `isCurrent` flag counts as an ongoing signal too, since a
// résumé can mark a role current without the dates string spelling out
// "Present" (e.g. "Since 2019").
function parseYearRangeFromDates(dates: string, now: Date, isCurrent: boolean): Interval | null {
  const years = dates.match(YEAR_RE)?.map(Number) ?? [];
  const ongoing = ONGOING_RE.test(dates) || isCurrent;

  if (ongoing && years.length >= 1) {
    return { start: years[0] * 12, end: nowMonthIndex(now) };
  }
  if (years.length >= 2) {
    const start = years[0] * 12;
    const end = years[years.length - 1] * 12;
    if (end >= start) return { start, end };
  }
  return null;
}

// Resolves a role's [start, end] interval in absolute month indices.
// Prefers the normalized start/end atoms; falls back to parsing the
// verbatim dates string (year granularity) when atoms don't fully resolve.
// Returns null when a duration truly can't be derived — the caller excludes
// that role from duration math rather than defaulting it to 0.
function roleInterval(entry: ExperienceEntry, now: Date): Interval | null {
  const start = entry.start ? atomToMonthIndex(entry.start) : null;
  const end = entry.end ? atomToMonthIndex(entry.end) : entry.isCurrent ? nowMonthIndex(now) : null;

  if (start !== null && end !== null && end >= start) return { start, end };

  const parsed = parseYearRangeFromDates(entry.dates, now, entry.isCurrent);
  if (parsed) return parsed;

  console.warn(`resume-metrics: could not derive a duration for role "${entry.title}" at "${entry.company}" (dates: "${entry.dates}") — excluded from duration math`);
  return null;
}

function mergeIntervalMonths(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let totalMonths = 0;
  let [curStart, curEnd] = [sorted[0].start, sorted[0].end];
  for (const { start, end } of sorted.slice(1)) {
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      totalMonths += curEnd - curStart;
      [curStart, curEnd] = [start, end];
    }
  }
  totalMonths += curEnd - curStart;
  return totalMonths;
}

// Exported standalone so atsScore.ts can fold this signal in without pulling
// in duration derivation (and its console-noted exclusions) for résumés it
// isn't scoring on tenure.
export function computeQuantifiedBulletRatio(store: ResumeStore): number {
  const bullets = [
    ...store.experience.flatMap((e) => e.bullets),
    ...store.projects.flatMap((p) => p.bullets),
  ];
  if (bullets.length === 0) return 0;
  const quantified = bullets.filter((b) => QUANTIFIED_RE.test(b)).length;
  return quantified / bullets.length;
}

export function computeResumeMetrics(store: ResumeStore, now: Date = new Date()): ResumeMetrics {
  const derivable = store.experience
    .map((entry) => roleInterval(entry, now))
    .filter((interval): interval is Interval => interval !== null);

  const totalMonths = mergeIntervalMonths(derivable);
  const totalYearsExperience = Math.round((totalMonths / 12) * 10) / 10;

  const currentStarts = store.experience
    .filter((e) => e.isCurrent)
    .map((e) => roleInterval(e, now))
    .filter((interval): interval is Interval => interval !== null)
    .map((interval) => interval.start);
  const currentTenureMonths = currentStarts.length > 0 ? nowMonthIndex(now) - Math.min(...currentStarts) : 0;

  const roleCount = store.experience.length;
  const durationDerivedRoleCount = derivable.length;
  const avgTenureMonths =
    derivable.length > 0 ? derivable.reduce((sum, { start, end }) => sum + (end - start), 0) / derivable.length : 0;

  const distinctSkillCount = new Set(store.skills.flatMap((g) => g.items)).size;
  const certificationCount = store.certifications.length;
  const languageCount = store.languages.length;

  const quantifiedBulletRatio = computeQuantifiedBulletRatio(store);

  return {
    totalYearsExperience,
    currentTenureMonths,
    roleCount,
    durationDerivedRoleCount,
    avgTenureMonths,
    distinctSkillCount,
    certificationCount,
    languageCount,
    quantifiedBulletRatio,
  };
}
