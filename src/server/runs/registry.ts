// In-memory run registry (system-architecture.md §6 decision 2: "inline
// async in the Node process (no queue infra); in-memory run registry keyed
// by search_runs.id; hard runtime cap. A restart kills a run (status
// running → mark stale on boot)." + decision 3: SSE with polling fallback).
//
// A run's SSE stream is only servable while its process is alive — a handle
// lives here for exactly that long. `GET /api/search/:id` falls back to the
// DB row (via searchRunsRepo) once a handle is gone (completed & evicted,
// or the process restarted); see task-B5-brief.md route contract.
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";

export type RunKind = "search" | "tailor";

export type RunEvent =
  | { event: "progress"; data: unknown }
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

const runs = new Map<string, RunHandle>();
// One active run id per persona — the 409-CONFLICT guard for
// `POST /api/search` (task-B5-brief.md route contract).
const activeRunByPersona = new Map<string, string>();

export function create(kind: RunKind, id: string, persona?: string): RunHandle {
  const handle = createRunHandle(kind, id);
  runs.set(id, handle);
  if (kind === "search" && persona) activeRunByPersona.set(persona, id);
  return handle;
}

export function get(id: string): RunHandle | undefined {
  return runs.get(id);
}

export function getActiveRunForPersona(persona: string): string | undefined {
  return activeRunByPersona.get(persona);
}

/** Called once a run reaches a terminal state — frees the per-persona slot. */
export function release(id: string, persona?: string): void {
  if (persona && activeRunByPersona.get(persona) === id) activeRunByPersona.delete(persona);
}

/** Test-only: clears all in-memory state between test cases. */
export function __resetForTests(): void {
  runs.clear();
  activeRunByPersona.clear();
}

// system-architecture.md §6 decision 2 — any `search_runs` row left `running`
// from a previous process (a restart mid-run) is stale: no handle for it
// exists in this fresh registry, so its SSE stream can never resume. Flip it
// to `failed` so `GET /api/search/:id` reports a terminal state instead of
// hanging forever in `running`. Call once on process start.
export async function markStaleRunningOnBoot(): Promise<void> {
  await searchRunsRepo.markAllRunningAsFailed("stale: process restarted while this run was in progress");
}
