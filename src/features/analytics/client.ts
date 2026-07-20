// posthog-js wrapper (spec §3). Initialised once from PostHogInit; every
// other export no-ops until then so callers never guard. Absent key =
// analytics off (one console.warn in production — no fallback key).
import posthog from "posthog-js";
import type { AnalyticsEvent } from "./events";

let initialized = false;

export function initAnalytics(): void {
  if (initialized) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[analytics] NEXT_PUBLIC_POSTHOG_KEY missing — analytics disabled");
    }
    return;
  }
  posthog.init(key, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    defaults: "2025-05-24",
    capture_exceptions: true,
    disable_session_recording: true,
  });
  initialized = true;
}

export function track(event: AnalyticsEvent, properties?: Record<string, string | number | boolean>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function identify(userId: string): void {
  if (!initialized) return;
  posthog.identify(userId);
}

export function resetAnalytics(): void {
  if (!initialized) return;
  posthog.reset();
}

export function captureException(error: Error): void {
  if (!initialized) return;
  posthog.captureException(error);
}

// Test-only reset (same pattern as creditsStore's __resetCreditsStore).
export function __resetAnalyticsForTest(): void {
  initialized = false;
}
