// Source-connector abstraction — system-architecture.md §3, quoted verbatim
// in .superpowers/sdd/task-B5-brief.md "Locked interfaces". B5 implements
// `discover` only; `fetchDetail` (apply-URL redirect resolution) and
// `extractQuestions` (F4 tiers 1/2) are declared here for the interface's
// shape but implemented in later slices — do not implement them in B5.
import type { Job } from "@/types";

export type ConnectorPersona = "remote" | "local" | "both";

export interface RoleTarget {
  titles: string[];
  keywords: string[];
  locationsPreferred?: string[];
  persona: "remote" | "local";
}

export interface RawPosting {
  sourceId: string;
  externalId?: string;
  url: string;
  title: string;
  company: string;
  location?: string;
  // Structured geo a connector can supply beyond the location string (e.g.
  // a payload's explicit remote flag — none confirmed yet; see the capture
  // task). Absent = derive from `location` via parseLocationGeo.
  geo?: import("./geo").ParsedGeo;
  description?: string;
  postedAt?: string;
  salaryRaw?: string;
}

// Internal shape a connector reports through `onProgress`; run.ts maps it
// into the wire `Progress` ({stage,current,total,label} — api-contract.md §4).
export interface ProgressEvent {
  stage: string;
  current: number;
  total: number;
  label: string;
}

// donor `ApplyAnswers`/`FormField` shape (system-architecture.md §1
// application_answers: `FormField {label, field_type, required, limit?,
// options?}`) — declared only so `extractQuestions`' signature typechecks.
// B7 owns the real, shared FormField type; this is not re-exported as
// contract surface.
export interface FormField {
  label: string;
  field_type: string;
  required: boolean;
  limit?: number;
  options?: string[];
}

export interface SourceConnector {
  id: string;
  kind: "ats" | "board";
  persona: ConnectorPersona;
  discover(ctx: {
    targets: RoleTarget[];
    since: Date;
    signal: AbortSignal;
    onProgress: (e: ProgressEvent) => void;
  }): AsyncIterable<RawPosting>;
  fetchDetail?(p: RawPosting): Promise<{ description: string; applyUrl?: string }>;
  extractQuestions?(job: Job): Promise<FormField[] | null>;
}
