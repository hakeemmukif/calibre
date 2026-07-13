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
const TERMINAL: ReadonlySet<CheckRunPhase> = new Set(["done", "needsText", "failed"]);

// Module-singleton state.
let runs: CheckRun[] = [];
let doneCount = 0;
const listeners = new Set<() => void>();
const pollFailures = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

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
  const polling = runs.filter((r) => r.checkId && !TERMINAL.has(r.phase));
  if (polling.length === 0) { stopTimerIfIdle(); return; }
  let snapshot;
  try {
    snapshot = await getChecksByIds(polling.map((r) => r.checkId!) as string[]);
  } catch {
    for (const r of polling) {
      const n = (pollFailures.get(r.key) ?? 0) + 1;
      pollFailures.set(r.key, n);
      if (n >= MAX_POLL_FAILURES) applyTerminalFailure(r.key);
    }
    return;
  }
  const byId = new Map(snapshot.checks.map((c) => [c.id, c]));
  for (const r of polling) {
    const c = byId.get(r.checkId!);
    if (!c) continue; // key still ours, but row not returned — keep waiting
    pollFailures.set(r.key, 0);
    await applySnapshot(r.key, c);
  }
  stopTimerIfIdle();
}

async function applySnapshot(key: string, c: UrlCheck) {
  const phase = phaseFor(c);
  if (phase === "done") {
    let job: Job | null = null;
    try { job = c.jobId ? await getJob(c.jobId) : null; }
    catch { const n = (pollFailures.get(key) ?? 0) + 1; pollFailures.set(key, n); if (n >= MAX_POLL_FAILURES) applyTerminalFailure(key); return; }
    const i = runs.findIndex((r) => r.key === key);
    if (i === -1) return; // dismissed mid-fetch
    // Inline mutation + doneCount + a SINGLE emit — doneCount must change in
    // the same notification as the run, or the feed reload effect (keyed on
    // doneCount) never fires.
    runs[i] = { ...runs[i], phase, stage: c.stage, checkId: c.id, jobId: c.jobId, job, alreadyKnown: c.alreadyKnown, finishedAt: Date.now() };
    doneCount += 1;
    emit();
    return;
  }
  upsert(key, { phase, stage: c.stage, error: c.error, finishedAt: TERMINAL.has(phase) ? Date.now() : null });
}

function applyTerminalFailure(key: string) {
  upsert(key, { phase: "failed", error: { code: "POLL_FAILED", message: "Lost contact with the check." }, finishedAt: Date.now() });
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
      upsert(key, { checkId: c.id, phase: phaseFor(c), stage: c.stage, alreadyKnown: c.alreadyKnown, error: c.error });
      if (c.status === "completed") void applySnapshot(key, c); // scored-dedupe short-circuit (202/200)
      else ensureTimer();
    })
    .catch(() => upsert(key, { phase: "failed", error: { code: "START_FAILED", message: "Couldn't start the check." }, finishedAt: Date.now() }));
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
    })
    .catch(() => upsert(key, { phase: "failed", error: { code: "EVALUATE_FAILED", message: "Re-scoring failed." }, finishedAt: Date.now() }));
  return key;
}

function retryWithText(key: string, text: string) {
  const run = runs.find((r) => r.key === key);
  if (!run) return;
  dismiss(key);
  submit(run.url, text);
}
function dismiss(key: string) { runs = runs.filter((r) => r.key !== key); pollFailures.delete(key); emit(); stopTimerIfIdle(); }
function clearFinished() { runs = runs.filter((r) => !TERMINAL.has(r.phase)); emit(); stopTimerIfIdle(); }

// Test-only reset.
export function __resetChecksStore() {
  runs = []; doneCount = 0; pollFailures.clear();
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
