// Spec §5 starter taxonomy — snake_case literals typed so a typo is a
// compile error. Add an event only when a concrete product question needs it.
export const EVENTS = {
  resumeUploaded: "resume_uploaded",
  scanStarted: "scan_started",
  applicationCreated: "application_created",
  tailorStarted: "tailor_started",
  creditsDepleted: "credits_depleted",
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];
