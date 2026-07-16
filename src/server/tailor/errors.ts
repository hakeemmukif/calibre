// Shared error types across server/tailor's async job engines (startTailor,
// correlate) — extracted from index.ts so correlate.ts doesn't import the
// whole tailor module (avoids a startTailor <-> correlate import cycle).
export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`No job with id "${jobId}".`);
    this.name = "UnknownJobError";
  }
}

export class NoActiveResumeError extends Error {
  constructor(message = "No résumé exists — tailoring requires an active résumé.") {
    super(message);
    this.name = "NoActiveResumeError";
  }
}

// startTailor's report resolution (index.ts): a caller-supplied `reportId`
// that doesn't resolve to a correlation_reports row this user owns (never
// created, or another user's — no existence leak, mirrors UnknownJobError).
export class UnknownReportError extends Error {
  constructor(reportId: string) {
    super(`No correlation report with id "${reportId}".`);
    this.name = "UnknownReportError";
  }
}

// emitTailorRewrite's fabrication pre-check (index.ts): the model wrote a
// number into an edit's `after` that isn't in the base résumé (e.g. a JD
// numeral like "5" bled in from "At least 5 years..."). Thrown INSIDE the
// corrective-retry loop so this is a retryable emission defect, not just the
// post-return honesty guard runTailorJob also applies (defense in depth).
export class TailorFabricationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailorFabricationError";
  }
}
