// Crash-beacon client helper (Task 4). sendBeacon with a typed Blob is the
// primary path — it survives page unload; fetch(keepalive) is the fallback
// where sendBeacon is missing or refuses the payload. Never throws: a failed
// report must not cascade into the error UI itself.
import type { ClientErrorReport } from "@/types";

export function reportClientError(error: Error & { digest?: string }): void {
  const report: ClientErrorReport = {
    message: (error.message || "Unknown client error").slice(0, 2000),
    stack: error.stack?.slice(0, 8000),
    url: window.location.href.slice(0, 2000),
    digest: error.digest?.slice(0, 200),
    at: new Date().toISOString(),
  };
  const payload = JSON.stringify(report);
  try {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/client-error", blob)) return;
  } catch {
    // fall through to fetch
  }
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}
