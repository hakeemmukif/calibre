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
