// Deterministic résumé metrics — no LLM. Fed by the start/end/isCurrent
// atoms resume-store.ts normalizes. Many real résumés (live-confirmed on
// the "SampleB" sample) carry year-only date ranges with no month atoms, so
// duration derivation falls back to parsing the verbatim `dates` string at
// year granularity (Jan convention) — never fabricated back into the
// stored atoms, this parsing lives only here.
import type { ResumeStore } from "./resume-store";

export interface ResumeMetrics {
  totalYearsExperience: number;
  currentTenureMonths: number;
  roleCount: number;
  avgTenureMonths: number;
  distinctSkillCount: number;
  certificationCount: number;
  languageCount: number;
  quantifiedBulletRatio: number;
}

type ExperienceEntry = ResumeStore["experience"][number];
type Interval = { start: number; end: number };

const YEAR_ONGOING_RE = /(\d{4})\s*[-–—]\s*(present|current|now|ongoing)\b/i;
const YEAR_RANGE_RE = /(\d{4})\s*[-–—]\s*(\d{4})/;
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
// resolve a role's duration.
function parseYearRangeFromDates(dates: string, now: Date): Interval | null {
  const ongoing = dates.match(YEAR_ONGOING_RE);
  if (ongoing) {
    return { start: Number(ongoing[1]) * 12, end: nowMonthIndex(now) };
  }
  const range = dates.match(YEAR_RANGE_RE);
  if (range) {
    const start = Number(range[1]) * 12;
    const end = Number(range[2]) * 12;
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

  const parsed = parseYearRangeFromDates(entry.dates, now);
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
    avgTenureMonths,
    distinctSkillCount,
    certificationCount,
    languageCount,
    quantifiedBulletRatio,
  };
}
