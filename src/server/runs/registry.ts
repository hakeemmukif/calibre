// In-memory run registry (system-architecture.md §6 decision 2: "inline
// async in the Node process (no queue infra); in-memory run registry keyed
// by search_runs.id; hard runtime cap. A restart kills a run (status
// running → mark stale on boot)." + decision 3: SSE with client
// auto-reconnect).
//
// A run's SSE stream is only servable while its process is alive — a handle
// lives here for exactly that long. `GET /api/search/:id` falls back to the
// DB row (via searchRunsRepo) once a handle is gone (completed & evicted,
// or the process restarted); see task-B5-brief.md route contract.
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";

export type RunKind = "search" | "tailor";

export type RunEvent =
  | { event: "progress"; data: unknown }
  | { event: "job"; data: unknown } // search only — B6's scored `Job` (api-contract.md §4)
  | { event: "done"; data: unknown }
  | { event: "error"; data: unknown };

type Listener = (event: RunEvent, id: number) => void;

export interface RunHandle {
  readonly id: string;
  readonly kind: RunKind;
  readonly signal: AbortSignal;
  /** Emits an event to all current subscribers; assigns a monotonic id. */
  emit(event: RunEvent): void;
  /** Subscribes to future events; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Aborts the run's AbortSignal (hard runtime cap / cancellation). */
  abort(reason: string): void;
  /** True once a terminal event ('done' | 'error') has been emitted. */
  readonly isTerminal: boolean;
}

function createRunHandle(kind: RunKind, id: string): RunHandle {
  const controller = new AbortController();
  const listeners = new Set<Listener>();
  let nextEventId = 1;
  let terminal = false;

  return {
    id,
    kind,
    signal: controller.signal,
    get isTerminal() {
      return terminal;
    },
    emit(event) {
      const eventId = nextEventId;
      nextEventId += 1;
      if (event.event === "done" || event.event === "error") terminal = true;
      for (const listener of listeners) listener(event, eventId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(reason) {
      controller.abort(reason);
    },
  };
}

// `next dev` can instantiate this module once per route bundle (POST
// /api/search and GET /api/search/:id are compiled/loaded independently) —
// plain module-level Maps would then give each route its own registry
// instance, so a handle registered by POST is invisible to GET, which
// falsely reports the run as not-streamable. Backing the state with
// `globalThis` ensures every bundle in the same process shares one instance.
const g = globalThis as unknown as {
  __caliberRunRegistry?: {
    runs: Map<string, RunHandle>;
    activeRunByPersona: Map<string, string>;
  };
};
g.__caliberRunRegistry ??= {
  runs: new Map<string, RunHandle>(),
  activeRunByPersona: new Map<string, string>(),
};
const runs = g.__caliberRunRegistry.runs;
// One active run id per (userId, persona) — the 409-CONFLICT guard for
// `POST /api/search` (task-B5-brief.md route contract). Keyed
// `${userId}:${persona}` (Step 3 task 4, per-user mutex — Fable design
// review: A's active run must never block B from starting one).
const activeRunByPersona = g.__caliberRunRegistry.activeRunByPersona;

function personaSlotKey(userId: string, persona: string): string {
  return `${userId}:${persona}`;
}

export function create(kind: RunKind, id: string, userId?: string, persona?: string): RunHandle {
  const handle = createRunHandle(kind, id);
  runs.set(id, handle);
  if (kind === "search" && userId && persona) activeRunByPersona.set(personaSlotKey(userId, persona), id);
  return handle;
}

export function get(id: string): RunHandle | undefined {
  return runs.get(id);
}

export function getActiveRunForPersona(userId: string, persona: string): string | undefined {
  return activeRunByPersona.get(personaSlotKey(userId, persona));
}

/** Called once a run reaches a terminal state — frees the per-persona slot. */
export function release(id: string, userId?: string, persona?: string): void {
  if (!userId || !persona) return;
  const key = personaSlotKey(userId, persona);
  if (activeRunByPersona.get(key) === id) activeRunByPersona.delete(key);
}

/** Test-only: clears all in-memory state between test cases. */
export function __resetForTests(): void {
  runs.clear();
  activeRunByPersona.clear();
}

// system-architecture.md §6 decision 2 — any `search_runs` row left `queued`
// or `running` from a previous process (a restart mid-run, or a restart
// between insert and fan-out) is stale: no handle for it exists in this
// fresh registry, so its SSE stream can never resume. Flip both to `failed`
// so `GET /api/search/:id` reports a terminal state instead of hanging
// forever. Call once on process start.
export async function markStaleRunningOnBoot(): Promise<void> {
  await searchRunsRepo.markAllUnfinishedAsFailed("stale: process restarted while this run was in progress");
}
