"use client";
import { useSyncExternalStore } from "react";
import type { Job, UrlCheck } from "@/types";
import { getJob, evaluateJob } from "@/features/feed/client";
import { startCheck, getChecksByIds } from "./client";

export type CheckRunPhase = "starting" | "queued" | "fetching" | "scoring" | "done" | "needsText" | "failed";

export interface CheckRun {
  key: string; checkId: string | null; url: string;
  origin: "paste" | "reevaluate"; jobId: string | null; job: Job | null;
  phase: CheckRunPhase; stage: string | null; alreadyKnown: boolean;
  error: { code: string; message: string } | null; startedAt: number; finishedAt: number | null;
}

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 8;
const MAX_TERMINAL_RUNS = 20; // completed runs retain the full Job (description text) for the tab's lifetime otherwise — cap the corner tray's memory footprint
const TERMINAL: ReadonlySet<CheckRunPhase> = new Set(["done", "needsText", "failed"]);

// Module-singleton state.
let runs: CheckRun[] = [];
let doneCount = 0;
const listeners = new Set<() => void>();
const pollFailures = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function emit() {
  // New array identity each change so useSyncExternalStore re-renders.
  runs = [...runs];
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
function upsert(key: string, patch: Partial<CheckRun>) {
  const i = runs.findIndex((r) => r.key === key);
  if (i === -1) return;
  runs[i] = { ...runs[i], ...patch };
  emit();
}
function phaseFor(c: UrlCheck): CheckRunPhase {
  if (c.status === "completed") return "done";
  if (c.status === "failed") return c.needsText ? "needsText" : "failed";
  // running/queued → split on server stage (never invented — raw passthrough)
  if (c.stage === "fetching" || c.stage === "searching") return "fetching";
  if (c.status === "queued") return "queued";
  return "scoring";
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => void pollTick(), POLL_MS);
}
function stopTimerIfIdle() {
  if (timer && !runs.some((r) => r.checkId && !TERMINAL.has(r.phase))) { clearInterval(timer); timer = null; }
}

async function pollTick() {
  if (pollInFlight) return; // no overlapping ticks — a batch poll slower than POLL_MS must not double-process
  const polling = runs.filter((r) => r.checkId && !TERMINAL.has(r.phase));
  if (polling.length === 0) { stopTimerIfIdle(); return; }
  pollInFlight = true;
  try {
    let snapshot;
    try {
      snapshot = await getChecksByIds(polling.map((r) => r.checkId!) as string[]);
    } catch {
      for (const r of polling) bumpFailure(r.key); // batch-poll failure counts against each run
      return;
    }
    const byId = new Map(snapshot.checks.map((c) => [c.id, c]));
    for (const r of polling) {
      const c = byId.get(r.checkId!);
      if (!c) continue; // key ours, row not returned — keep waiting (no reset, no bump)
      await applySnapshot(r.key, c); // applySnapshot resets on success / bumps on getJob failure
    }
  } finally {
    pollInFlight = false;
    stopTimerIfIdle();
  }
}

function bumpFailure(key: string) {
  if (!runs.some((r) => r.key === key)) return; // dismissed — drop
  const n = (pollFailures.get(key) ?? 0) + 1;
  pollFailures.set(key, n);
  if (n >= MAX_POLL_FAILURES) applyTerminalFailure(key);
}

async function applySnapshot(key: string, c: UrlCheck) {
  const phase = phaseFor(c);
  if (phase === "done") {
    const cur = runs.find((r) => r.key === key);
    if (!cur || TERMINAL.has(cur.phase)) return; // dismissed, or an earlier apply already finished it
    let job: Job | null = null;
    try {
      job = c.jobId ? await getJob(c.jobId) : null;
    } catch {
      bumpFailure(key); // persistent getJob failure eventually fails THIS run (not an eternal spinner)
      return;
    }
    const i = runs.findIndex((r) => r.key === key);
    if (i === -1 || TERMINAL.has(runs[i].phase)) return; // dismissed, or finished during the getJob await
    pollFailures.set(key, 0);
    // Run mutation + doneCount + a SINGLE emit — doneCount must change in the
    // same notification as the run, or the feed reload effect never fires.
    runs[i] = { ...runs[i], phase, stage: c.stage, checkId: c.id, jobId: c.jobId, job, alreadyKnown: c.alreadyKnown, finishedAt: Date.now() };
    doneCount += 1;
    emit();
    trimTerminal();
    return;
  }
  pollFailures.set(key, 0); // a definitive server snapshot is a successful poll — reset the streak
  upsert(key, { phase, stage: c.stage, error: c.error, finishedAt: TERMINAL.has(phase) ? Date.now() : null });
  if (TERMINAL.has(phase)) trimTerminal(); // server-reported failed/needsText lands here, not in the done branch
}

function applyTerminalFailure(key: string) {
  upsert(key, { phase: "failed", error: { code: "POLL_FAILED", message: "Lost contact with the check." }, finishedAt: Date.now() });
  trimTerminal();
}

// Evict the oldest TERMINAL runs beyond MAX_TERMINAL_RUNS. Iterates in the
// existing newest-first order so remaining runs stay newest-first; active
// runs are never counted or removed. A separate emit (only when something
// was actually evicted) — the doneCount/emit coupling above is about the
// done TRANSITION landing atomically, not about this unrelated eviction.
function trimTerminal() {
  let seen = 0;
  const kept: CheckRun[] = [];
  let evicted = false;
  for (const r of runs) {
    if (TERMINAL.has(r.phase)) {
      seen += 1;
      if (seen > MAX_TERMINAL_RUNS) { evicted = true; pollFailures.delete(r.key); continue; }
    }
    kept.push(r);
  }
  if (evicted) { runs = kept; emit(); }
}

function addRun(run: CheckRun) { runs = [run, ...runs]; emit(); }

// ---- public API (bound into the hook) ----
function submit(url: string, text?: string): string {
  const existing = runs.find((r) => r.url === url && !TERMINAL.has(r.phase) && r.origin === "paste");
  if (existing) return existing.key;
  const key = crypto.randomUUID();
  addRun({ key, checkId: null, url, origin: "paste", jobId: null, job: null, phase: "starting", stage: null, alreadyKnown: false, error: null, startedAt: Date.now(), finishedAt: null });
  pollFailures.set(key, 0);
  // Coerce empty text → undefined: UrlCheckRequest.text is min(1).optional(),
  // so a plain retry (retryWithText(key, "")) must NOT send text:"" (server
  // would 422). Empty ⇒ URL mode.
  const cleanText = text && text.length > 0 ? text : undefined;
  void startCheck({ url, text: cleanText })
    .then((c) => {
      if (!runs.some((r) => r.key === key)) return; // dismissed before start resolved
      if (c.status === "completed") {
        // Scored-dedupe short-circuit: DON'T set phase:'done' here (job/doneCount
        // would land in an earlier emit than the run). applySnapshot owns the done
        // transition; ensureTimer is the retry backstop if its getJob fails.
        upsert(key, { checkId: c.id, stage: c.stage, alreadyKnown: c.alreadyKnown });
        ensureTimer();
        void applySnapshot(key, c);
      } else {
        upsert(key, { checkId: c.id, phase: phaseFor(c), stage: c.stage, alreadyKnown: c.alreadyKnown, error: c.error });
        if (!TERMINAL.has(phaseFor(c))) ensureTimer(); // don't spin the timer for an already-terminal start
      }
    })
    .catch(() => { upsert(key, { phase: "failed", error: { code: "START_FAILED", message: "Couldn't start the check." }, finishedAt: Date.now() }); trimTerminal(); });
  return key;
}

function submitEvaluate(jobId: string): string {
  const existing = runs.find((r) => r.jobId === jobId && r.origin === "reevaluate" && !TERMINAL.has(r.phase));
  if (existing) return existing.key;
  const key = crypto.randomUUID();
  addRun({ key, checkId: null, url: `job:${jobId}`, origin: "reevaluate", jobId, job: null, phase: "scoring", stage: "scoring", alreadyKnown: false, error: null, startedAt: Date.now(), finishedAt: null });
  void evaluateJob(jobId)
    .then((freshJob) => {
      const i = runs.findIndex((r) => r.key === key);
      if (i === -1) return; // dismissed mid-evaluate
      runs[i] = { ...runs[i], phase: "done", job: freshJob, finishedAt: Date.now() };
      doneCount += 1;
      emit(); // single notification carries both the run and doneCount
      trimTerminal();
    })
    .catch(() => { upsert(key, { phase: "failed", error: { code: "EVALUATE_FAILED", message: "Re-scoring failed." }, finishedAt: Date.now() }); trimTerminal(); });
  return key;
}

function retryWithText(key: string, text: string) {
  const run = runs.find((r) => r.key === key);
  if (!run) return;
  dismiss(key);
  submit(run.url, text);
}
function dismiss(key: string) { runs = runs.filter((r) => r.key !== key); pollFailures.delete(key); emit(); stopTimerIfIdle(); }
function clearFinished() {
  for (const r of runs) if (TERMINAL.has(r.phase)) pollFailures.delete(r.key);
  runs = runs.filter((r) => !TERMINAL.has(r.phase));
  emit(); stopTimerIfIdle();
}

// Test-only reset.
export function __resetChecksStore() {
  runs = []; doneCount = 0; pollFailures.clear(); pollInFlight = false;
  if (timer) { clearInterval(timer); timer = null; }
}

let snapshotCache = { runs, doneCount };
function getSnapshot() {
  // Return a NEW object when data changes so useSyncExternalStore re-renders;
  // keep the SAME reference when unchanged so it doesn't loop. (Mutating a
  // stable object would defeat the identity check and skip re-renders.)
  if (snapshotCache.runs !== runs || snapshotCache.doneCount !== doneCount) {
    snapshotCache = { runs, doneCount };
  }
  return snapshotCache;
}

export function useUrlChecks() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    runs: snap.runs,
    active: snap.runs.filter((r) => !TERMINAL.has(r.phase)),
    doneCount: snap.doneCount,
    submit, submitEvaluate, retryWithText, dismiss, clearFinished,
  };
}
