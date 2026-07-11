// Ephemeral résumé-upload → feed handoff. When a résumé upload kicks off the
// dual-persona scan, the run ids are stashed here so /feed can attach its
// ScanProgress overlay to the ALREADY-running run instead of starting a new
// one. sessionStorage (not a query param) — the run ids must not survive a
// shared/bookmarked URL, and the handoff is single-use.
import type { Persona } from "@/types";

const KEY = "caliber.scan.runIds";

export type ScanHandoff = Partial<Record<Persona, string>>;

export function writeScanHandoff(handoff: ScanHandoff): void {
  if (Object.keys(handoff).length === 0) return;
  sessionStorage.setItem(KEY, JSON.stringify(handoff));
}

// Read-and-clear: the handoff is consumed exactly once, on the feed's first
// mount. A corrupt value (e.g. written by an older build) degrades to "no
// handoff" — this is transient UI state, not a system boundary, so it must not
// throw and block the feed from loading.
export function takeScanHandoff(): ScanHandoff {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return {};
  sessionStorage.removeItem(KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ScanHandoff) : {};
  } catch {
    return {};
  }
}
