import type { Tone } from "../../types";
import type { FitBarTone } from "../components/FitBar";

// agoLabel — the one relative-time formatter shared by every composition
// that renders a contract ISO timestamp as "3d ago" (ResumeView.updatedAt,
// TrackerTable/JobDetail.appliedAt, …). Day granularity below a month, whole
// months above it — the donor-shape versions duplicated this; this is the
// one behavior everyone uses now.
export function agoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

// toFitBarTone — a Job breakdown row's `tone` is the wider contract Tone;
// FitBar only knows good/warn/weak. Shared by EvalResultCard and JobDetail
// so the mapping lives in exactly one place instead of two copies.
export function toFitBarTone(tone: Tone | undefined): FitBarTone | undefined {
  switch (tone) {
    case "good":
    case "verified":
      return "good";
    case "warn":
    case "danger":
      return "warn";
    case "ghost":
      return "weak";
    default:
      return undefined;
  }
}
