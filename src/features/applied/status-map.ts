// F5 tracker status folding (task-B9-brief.md "locked interfaces";
// design spec §5 "Key adaptation — application status": donor statuses
// (Evaluated/Applied/Responded/Interview/Offer/Rejected/Discarded/SKIP) fold
// onto the frozen 4-stage `stage` + `statusTone` here — the ONLY place this
// mapping happens (system-architecture.md §1 applications reconciliation).
// No markdown parsing ported: this is a pure fold over (stage, outcome).
//
// Tone is driven by OUTCOME, not stage alone — 'verified'/'neutral' are
// unreachable from stage: an application can sit at any stage while still
// "open" (good), a stage-3 application that lands an offer turns 'verified',
// and any application can close (rejected/withdrawn) at any stage -> 'neutral'.
import type { Application } from "@/types";

export type AppOutcome = "open" | "offer" | "closed";

type Stage = Application["stage"];
type StatusTone = Application["statusTone"];

// Applied -> Screen -> Interview -> Decision (the 4-stage pipeline, §5).
const OPEN_LABEL: Record<Stage, string> = {
  0: "Applied",
  1: "Screening",
  2: "Interviewing",
  3: "Awaiting decision",
};

export function foldStatus(stage: Stage, outcome: AppOutcome): { statusLabel: string; statusTone: StatusTone } {
  if (outcome === "offer") return { statusLabel: "Offer", statusTone: "verified" };
  if (outcome === "closed") return { statusLabel: "Rejected", statusTone: "neutral" };
  return { statusLabel: OPEN_LABEL[stage], statusTone: "good" };
}
