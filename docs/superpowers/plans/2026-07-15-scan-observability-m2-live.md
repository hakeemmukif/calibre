# Scan Observability — M2 (Live View / Concurrency Lanes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Depends on M0 (merged) and M1 (`/scans/:id`, persisted `results`, widened `stats`).**

**Goal:** Turn a running `/scans/:id` from the coarse 4-stage bar into a verbose live view — a source-discovery strip plus per-job scoring lanes showing each concurrent job's real sub-phase (fetching → reading JD → scoring → re-scoring → done) — by emitting two new idempotent SSE events, a synchronous `snapshot` on subscribe for clean reconnects, and a client reducer that folds the stream into lanes.

**Architecture:** Two new **state-setting / idempotent** SSE events (`source`, `jobPhase`) are added to the Zod union, the registry `RunEvent` type, and the client `eventNames` array. `run.ts` owns a `currentFrame` (source states + active-job phases + counts) attached to the `RunHandle` as an opaque slot — the registry stays generic. On subscribe the route emits one `snapshot` synchronously before live deltas, so a late/reconnecting client hydrates with no event replay. Lanes are **pure client presentation**: a `useScanLive` reducer folds events into `{ sources, activeJobs, counts }` and assigns each active `jobId` to a free visual slot. Reuses `StageGlyph` + the `caliber-pulse`/`caliber-spin` CSS keyframes.

**Tech Stack:** TypeScript, Next.js 15 App Router SSE (`ReadableStream`), Zod, in-memory run registry (`globalThis` singleton), Vitest + Testing Library, `caliber-ui`.

## Global Constraints

- **Idempotent deltas:** every new event sets absolute state, never increments. A duplicate or out-of-order delta is harmless; reconnect needs no replay.
- **Registry stays generic:** the registry knows nothing about lanes. `currentFrame` is an opaque slot on the `RunHandle`; only `run.ts` (writer) and the `[id]` route (reader, for the snapshot) touch it.
- **Client owns lane assignment:** the server emits per-`jobId` phases with no lane/slot index. Visual slotting is 100% client-side.
- **Fail loud:** validate events with `SseEvent.parse`; a malformed frame throws, not silently drops.
- **No new persistence:** M2 is stream + UI only. `results`/`stats` writes are unchanged from M1. The live phases are ephemeral (the durable record is M1's `results`).
- **Layering + surgical diffs + green gate (`npm run check`)** as in M0/M1.

## Task Assignments (model · effort · goal)

| Task | Agent / model | Effort | Verifiable goal |
|------|---------------|--------|-----------------|
| 1 — Event vocabulary (Zod + RunEvent + eventNames) | `executor` (sonnet) | medium | `source`/`jobPhase`/`snapshot` are in the `SseEvent` union, `RunEvent`, and client `eventNames`; parse tests green |
| 2 — `currentFrame` on the RunHandle | `executor` (sonnet) | medium | An opaque frame slot exists on `RunHandle` (a closure var + getter/setter); registry stays kind-generic; unit test proves frame reflects last state |
| 3 — Emit `source` + `jobPhase` from `run.ts` | `deep-thinker` (fable) | high | Discovery emits `source` deltas; each job emits `jobPhase` at its real sub-steps; frame context threaded into `scoreTopCandidates`; run test asserts the emitted stream |
| 4 — `snapshot`-on-subscribe in the SSE route | `deep-thinker` (fable) | high | A late subscriber receives one `snapshot` frame before live deltas; route test proves hydration + no replay |
| 5 — `useScanLive` reducer + client lane assignment | `deep-thinker` (fable) | high | Reducer folds events → `{sources, activeJobs, counts}`, idempotent, assigns stable visual slots; reducer unit tests green |
| 6 — `SourceStrip` + `ScanLanes` compositions | `executor` (sonnet) | medium | Presentational strip + lanes reuse `StageGlyph`/motion; dom tests green |
| 7 — Wire live view into `/scans/:id` | `executor` (sonnet) | medium | Running run shows lanes (replaces the M1 coarse bridge); terminal run still shows `ScanReplay`; dom test green |
| 8 — Full-gate + contract regen | `executor` (sonnet) | low | `npm run check` green; api-contract + component-inventory updated |

---

### Task 1: Event vocabulary — `source`, `jobPhase`, `snapshot`

**Model · effort · goal:** `executor` (sonnet) · medium · The three new events parse via `SseEvent`, are present in the registry `RunEvent` union and the client `eventNames` array, and a round-trip parse test passes; no emitter/consumer wired yet.

**Files:**
- Modify: `src/types/index.ts` (`SseEvent` union ~`:288-294`)
- Modify: `src/server/runs/registry.ts` (`RunEvent` ~`:15-19`)
- Modify: `src/features/search/client.ts` (`eventNames` ~`:36`)
- Test: `src/types/sseEvent.test.ts` (add cases)

**Interfaces:**
- Consumes: `LegitimacyTier` (`:13`).
- Produces:
  - `SourceEvent` data: `{ sourceId, name, status: "fetching"|"done"|"error", found?, error? }`
  - `JobPhaseEvent` data: `{ jobId, title, company, source, phase: "fetching"|"readingJD"|"scoring"|"rescoring"|"done"|"error", verdict?, legitimacyTier?, fit? }`
  - `ScanFrame` (snapshot payload): `{ sources: SourceState[], activeJobs: JobPhaseState[], counts: { scored, queued, total } }`
  - `SseEvent` union extended with `source`, `jobPhase`, `snapshot`

- [ ] **Step 1: Write the failing parse test**

Add to `src/types/sseEvent.test.ts` (create if absent):

```ts
import { describe, expect, it } from "vitest";
import { SseEvent } from "./index";

describe("SseEvent M2 additions", () => {
  it("parses a source delta", () => {
    const e = SseEvent.parse({ event: "source", data: { sourceId: "s1", name: "Greenhouse", status: "fetching" } });
    expect(e.event).toBe("source");
  });
  it("parses a jobPhase delta with a sub-phase", () => {
    const e = SseEvent.parse({ event: "jobPhase", data: { jobId: "j1", title: "DE", company: "Acme", source: "s1", phase: "scoring" } });
    expect(e.event).toBe("jobPhase");
  });
  it("parses a snapshot frame", () => {
    const e = SseEvent.parse({ event: "snapshot", data: { sources: [], activeJobs: [], counts: { scored: 0, queued: 30, total: 30 } } });
    expect(e.event).toBe("snapshot");
  });
  it("rejects an unknown phase", () => {
    expect(() => SseEvent.parse({ event: "jobPhase", data: { jobId: "j", title: "t", company: "c", source: "s", phase: "teleporting" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL** (union has only `progress`/`job`/`done`/`error`).

- [ ] **Step 3: Add the schemas + extend the union** in `src/types/index.ts`, before `SseEvent`:

```ts
export const SourceEventData = z.object({
  sourceId: z.string(),
  name: z.string(),
  status: z.enum(["fetching", "done", "error"]),
  found: z.number().int().optional(),
  error: z.string().optional(),
});
export type SourceEventData = z.infer<typeof SourceEventData>;

export const JobPhaseData = z.object({
  jobId: z.string(),
  title: z.string(),
  company: z.string(),
  source: z.string(),
  phase: z.enum(["fetching", "readingJD", "scoring", "rescoring", "done", "error"]),
  verdict: z.enum(["Apply", "Consider", "Research first", "Skip"]).optional(),
  legitimacyTier: LegitimacyTier.optional(),
  fit: z.number().min(0).max(5).optional(),
});
export type JobPhaseData = z.infer<typeof JobPhaseData>;

export const ScanFrame = z.object({
  sources: z.array(SourceEventData),
  activeJobs: z.array(JobPhaseData),
  counts: z.object({ scored: z.number().int(), queued: z.number().int(), total: z.number().int() }),
});
export type ScanFrame = z.infer<typeof ScanFrame>;
```

Then extend the discriminated union (`:288-294`):

```ts
export const SseEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), data: Progress }),
  z.object({ event: z.literal("job"), data: Job }),
  z.object({ event: z.literal("source"), data: SourceEventData }),
  z.object({ event: z.literal("jobPhase"), data: JobPhaseData }),
  z.object({ event: z.literal("snapshot"), data: ScanFrame }),
  z.object({ event: z.literal("done"), data: z.union([SearchRun, TailoredResume]) }),
  z.object({ event: z.literal("error"), data: ErrorEnvelope }),
]);
```

- [ ] **Step 4: Extend `RunEvent`** in `src/server/runs/registry.ts` (`:15-19`) — keep it opaque (`data: unknown`), just add the names:

```ts
export type RunEvent =
  | { event: "progress"; data: unknown }
  | { event: "job"; data: unknown }
  | { event: "source"; data: unknown }
  | { event: "jobPhase"; data: unknown }
  | { event: "snapshot"; data: unknown }
  | { event: "done"; data: unknown }
  | { event: "error"; data: unknown };
```

- [ ] **Step 5: Extend the client `eventNames`** in `src/features/search/client.ts` (`:36`):

```ts
  const eventNames = ["progress", "job", "source", "jobPhase", "snapshot", "done", "error"] as const;
```

(`snapshot` is a normal named SSE event here; `subscribeSearch` will forward it to the reducer in Task 5. `done`/`error` still self-close the stream.)

- [ ] **Step 6: Run → PASS.** `npx vitest run src/types/sseEvent.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/server/runs/registry.ts src/features/search/client.ts src/types/sseEvent.test.ts
git commit -m "feat(sse): source/jobPhase/snapshot event vocabulary"
```

---

### Task 2: `currentFrame` on the RunHandle (opaque slot)

**Model · effort · goal:** `executor` (sonnet) · medium · The `RunHandle` carries an opaque, mutable frame slot the run engine owns and the route reads; the registry remains kind-generic (no lane knowledge); a unit test proves the frame holds the last-set state.

**Files:**
- Modify: `src/server/runs/registry.ts` (`RunHandle` interface ~`:21-35`; `createRunHandle` ~`:37-63`)
- Test: `src/server/runs/registry.test.ts` (add a frame case)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `RunHandle.frame: unknown` (mutable slot, default `null`)
  - `RunHandle.setFrame(frame: unknown): void`

Keeping the slot typed `unknown` is deliberate — the registry stays generic over run kind; `run.ts` casts to `ScanFrame` on write and the route casts on read.

- [ ] **Step 1: Write the failing test**

```ts
  it("carries an opaque frame slot the engine sets and readers get", () => {
    const handle = create("search", "run-frame", USER_ID, "remote");
    expect(handle.frame).toBeNull();
    handle.setFrame({ sources: [], activeJobs: [], counts: { scored: 0, queued: 2, total: 2 } });
    expect((handle.frame as { counts: { queued: number } }).counts.queued).toBe(2);
  });
```

- [ ] **Step 2: Run → FAIL** (`frame`/`setFrame` don't exist).

- [ ] **Step 3: Add the slot** to the `RunHandle` interface (`:21-35`):

```ts
  readonly isTerminal: boolean;
  readonly frame: unknown;          // opaque live-view frame; engine-owned, route-read
  setFrame(frame: unknown): void;
```

and in `createRunHandle` (`:37-63`) back it with a closure variable:

```ts
  let frame: unknown = null;
  // …
  return {
    // … existing fields …
    get frame() { return frame; },
    setFrame(next: unknown) { frame = next; },
  };
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/server/runs/registry.ts src/server/runs/registry.test.ts
git commit -m "feat(registry): opaque currentFrame slot on RunHandle"
```

---

### Task 3: Emit `source` + `jobPhase` from `run.ts` and keep the frame current

**Model · effort · goal:** `deep-thinker` (fable) · high · Discovery emits a `source` delta as each connector starts/finishes; each scoring job emits `jobPhase` at its real sub-steps (fetching → readingJD → scoring → [rescoring] → done/error); every emit also updates `handle.setFrame(...)` idempotently; a run test asserts the emitted event stream and the final frame.

**Files:**
- Modify: `src/server/search/run.ts` (a `ScanFrameBuilder` owned in `runFanOut`; discovery task loop ~`:218-264`; `scoreTopCandidates` signature + scoring pool callback ~`:410-515`)
- Modify: `src/server/score/index.ts` (add an `onPhase?` callback so `scoreJob` reports its internal sub-steps) — see Interfaces
- Test: `src/server/search/run.test.ts` (add an event-capture case)

**Interfaces:**
- Consumes: `handle.emit` / `handle.setFrame` (Task 2), `SourceEventData` / `JobPhaseData` / `ScanFrame` (Task 1).
- Produces:
  - `scoreJob` gains `onPhase?: (phase: "fetching"|"readingJD"|"scoring"|"rescoring") => void`, invoked before each internal step (liveness=`fetching`, jdFacts=`readingJD`, matchScore=`scoring`, escalation=`rescoring`). Optional — the url-check path passes nothing.
  - **`scoreTopCandidates` gains a 9th param `frame: ScanFrameBuilder`** (below) so the scoring pool can emit `jobPhase` + push frames. The counts (`scored`/`total`/`queued`) it needs live *inside* `scoreTopCandidates`, so the builder is passed in, not read from `runFanOut`'s scope.

> **B4 — scope correction:** the frame's counts (`scored`, `doneCount`, top-N `total`) are local to **`scoreTopCandidates`** (`run.ts:410-523`), a *different* function from `runFanOut` where the source states live. So the frame is a small stateful **builder object** created in `runFanOut` and **passed into `scoreTopCandidates`** — not a closure reading cross-function locals. The builder holds the source-state + active-job Maps and a `pushFrame(counts)` that the caller supplies counts to.

- [ ] **Step 1: Write the failing event-capture test**

In `src/server/search/run.test.ts`, add a helper that subscribes to the handle via the registry and records events, then:

```ts
  it("emits source + jobPhase deltas and leaves a coherent final frame", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const posting: RawPosting = { sourceId: good.id, url: "https://example.com/jobs/a", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." };

    const events: { event: string; data: any }[] = [];
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, {
      llm: costingLlm, connectorForSource: (s) => stubConnector(s, [posting]),
      onHandle: (h) => h.subscribe((e) => events.push(e as any)), // test-only dep to grab the handle
    });
    await waitForTerminal(runsRepo, run.id);

    const sourceEvents = events.filter((e) => e.event === "source");
    expect(sourceEvents.map((e) => e.data.status)).toContain("done");
    const phases = events.filter((e) => e.event === "jobPhase" && e.data.jobId).map((e) => e.data.phase);
    expect(phases).toEqual(expect.arrayContaining(["readingJD", "scoring", "done"]));
  });
```

(`onHandle?: (h: RunHandle) => void` is a tiny test-only `StartSearchDeps` seam called right after the handle is created in `startSearch`. If the registry already lets a test look up the handle by run id synchronously — `get(run.id)` — use that instead and drop the dep. Check `registry.get` timing before adding the seam.)

- [ ] **Step 2: Run → FAIL** (no `source`/`jobPhase` events emitted).

- [ ] **Step 3: Add a `ScanFrameBuilder` in `run.ts`, created in `runFanOut`, passed into `scoreTopCandidates`**

Define a small builder that owns the source-state + active-job Maps and pushes an absolute (idempotent) frame onto the handle. It takes counts *as an argument* to `pushFrame`, so the scoring function (which owns the counts) supplies them, and discovery (which has no counts yet) passes zeros:

```ts
type ScanFrameBuilder = {
  setSource(s: SourceEventData): void;
  setJob(j: JobPhaseData): void;   // done/error self-remove from the active set
  pushFrame(counts: ScanFrame["counts"]): void;
};

function createScanFrameBuilder(handle: RunHandle): ScanFrameBuilder {
  const sources = new Map<string, SourceEventData>();
  const active = new Map<string, JobPhaseData>();
  const push = (counts: ScanFrame["counts"]) =>
    handle.setFrame({
      sources: [...sources.values()],
      activeJobs: [...active.values()].filter((j) => j.phase !== "done" && j.phase !== "error"),
      counts,
    } satisfies ScanFrame);
  return {
    setSource(s) { sources.set(s.sourceId, s); },
    setJob(j) { if (j.phase === "done" || j.phase === "error") active.delete(j.jobId); else active.set(j.jobId, j); },
    pushFrame: push,
  };
}
```

In `runFanOut`, create it once: `const frame = createScanFrameBuilder(handle);` (above the `try`, so both discovery and the scoring call reach it). Add `frame` as the 9th argument to the `scoreTopCandidates(...)` call and to its signature (`:410-419`).

- [ ] **Step 4: Emit `source` deltas in discovery**

In the per-source `limit(async …)` task (`:218-264`), emit on start and on settle, updating the frame each time. The sources table's display column is **`sources.name`** (`schema.ts:76`) — not `label` (which doesn't exist). No `?? source.id` fallback (project no-fallback rule; `name` is NOT NULL):

```ts
      const emitSource = (data: SourceEventData) => { frame.setSource(data); handle.emit({ event: "source", data }); frame.pushFrame({ scored: 0, queued: 0, total: 0 }); };
      emitSource({ sourceId: source.id, name: source.name, status: "fetching" });
      try {
        const found = await /* existing connector fetch */;
        emitSource({ sourceId: source.id, name: source.name, status: "done", found: found.length });
      } catch (err) {
        emitSource({ sourceId: source.id, name: source.name, status: "error", error: err instanceof Error ? err.message : String(err) });
      }
```

(Wrap the *existing* fetch/`perSource` bookkeeping — don't replace it; add the `source` emits + frame updates around it. Discovery-time frames pass zero counts — the strip is source-focused then; the counts fill in once scoring starts.)

- [ ] **Step 5: Thread `onPhase` through `scoreJob`**

In `src/server/score/index.ts`, add `onPhase?` to the args type (next to `signal?`) and call it before each internal LLM step:

```ts
  signal?: AbortSignal;
  onPhase?: (phase: "fetching" | "readingJD" | "scoring" | "rescoring") => void;
}): Promise<JobScoreRow> {
```

Invoke it: `args.onPhase?.("fetching")` before liveness; `args.onPhase?.("readingJD")` before `extractJdFacts`; `args.onPhase?.("scoring")` before the cheap `scoreMatch`; `args.onPhase?.("rescoring")` before the escalation `scoreMatch`. (Pure notifications — no behavior change.)

- [ ] **Step 6: Emit `jobPhase` in the scoring pool**

In the pool callback (`:463-515`), set the active job and emit at each transition. The counts come from `scoreTopCandidates`'s own locals (`scored`, `doneCount`, `topCandidates.length`) — that's the whole point of passing `frame` in. On entry:

```ts
        const counts = () => ({ scored, queued: Math.max(0, topCandidates.length - doneCount), total: topCandidates.length });
        const emitPhase = (phase: JobPhaseData["phase"], extra?: Partial<JobPhaseData>) => {
          const data: JobPhaseData = { jobId: job.id, title: job.title, company: job.company, source: source.id, phase, ...extra };
          frame.setJob(data);
          handle.emit({ event: "jobPhase", data });
          frame.pushFrame(counts());
        };
        emitPhase("fetching");
```

Pass `onPhase: (p) => emitPhase(p)` into the `scoreJob` call. On success, before/with the `job` emit (numeric fit is **`scoreRow.score`**, not the jsonb `scoreRow.fit`):

```ts
          emitPhase("done", { verdict: scoreRow.verdict, legitimacyTier: scoreRow.legitimacy.tier, fit: scoreRow.score });
```

On the catch branches, `emitPhase("error")`. `frame.setJob` deletes `done`/`error` jobs from the active set, so a settled job leaves the lanes automatically — idempotent.

- [ ] **Step 7: Run the run suite → PASS.** `npx vitest run src/server/search/run.test.ts` — the new capture test sees `source` `done` + `jobPhase` `readingJD/scoring/done`; all M0/M1 tests still green (the new events are additive; the coarse `progress` events are unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/server/search/run.ts src/server/score/index.ts src/server/search/run.test.ts
git commit -m "feat(search): emit source + jobPhase live deltas and keep currentFrame current"
```

---

### Task 4: `snapshot`-on-subscribe in the SSE route

**Model · effort · goal:** `deep-thinker` (fable) · high · When a client subscribes to a running run, the route emits exactly one `snapshot` event (from `handle.frame`) synchronously before forwarding live deltas; a route test proves a late subscriber hydrates from the snapshot and receives no event replay.

**Files:**
- Modify: `src/app/api/search/[id]/route.ts` (the live-subscriber `start()` block ~`:98-105`)
- Test: `src/app/api/search/[id]/route.test.ts` (add a snapshot-hydration case)

**Interfaces:**
- Consumes: `handle.frame` (Task 2), `sseLine` (`:18`), `ScanFrame` (Task 1).
- Produces: a leading `snapshot` SSE line on subscribe when a live handle exists and `handle.frame` is non-null.

- [ ] **Step 1: Write the failing route test** — start a run so a live handle + non-null frame exists, then open an SSE reader and assert the first non-heartbeat line is `event: snapshot`:

```ts
  it("emits a snapshot before live deltas for a late subscriber", async () => {
    // start a run (registry has a live handle with a frame); then subscribe via SSE
    const res = await GET(new NextRequest("http://x/api/search/" + runId, { headers: { accept: "text/event-stream" } }), { params: Promise.resolve({ id: runId }) });
    const text = await readFirstEvents(res, 1); // helper: read until the first `event:` line
    expect(text).toContain("event: snapshot");
  });
```

(Use the test file's existing SSE-reading helper; if none, read `res.body` via `getReader()` and decode until the first `event:` line.)

- [ ] **Step 2: Run → FAIL** (no snapshot emitted).

- [ ] **Step 3: Emit the snapshot in the live branch**

In `[id]/route.ts`, in the live-handle branch (`:98-105`), before wiring `handle.subscribe(...)`, enqueue the current frame if present:

```ts
        if (handle.frame) {
          controller.enqueue(encoder.encode(sseLine("snapshot", handle.frame, 0)));
        }
        const unsubscribe = handle.subscribe((event, eventId) => {
          if (closed) return;
          controller.enqueue(encoder.encode(sseLine(event.event, event.data, eventId)));
          if (event.event === "done" || event.event === "error") { unsubscribe(); close(); }
        });
```

Event id `0` marks the pre-subscription hydration frame (live deltas start at the registry's monotonic ids ≥1). Because `source`/`jobPhase` deltas are idempotent state-setters, any delta the client also receives live after the snapshot simply re-sets the same absolute state — no double-count, no replay needed.

- [ ] **Step 4: Run → PASS.** The first event line is `snapshot`; subsequent lines are live deltas.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/search/[id]/route.ts" "src/app/api/search/[id]/route.test.ts"
git commit -m "feat(sse): snapshot-on-subscribe for clean live reconnect"
```

---

### Task 5: `useScanLive` reducer + client lane assignment

**Model · effort · goal:** `deep-thinker` (fable) · high · A `useScanLive(runId)` hook consumes the enriched stream and folds `snapshot`/`source`/`jobPhase` into `{ sources, activeJobs, counts }`, idempotently (duplicate/out-of-order deltas converge), and assigns each active `jobId` a stable visual slot; reducer unit tests prove idempotency, slot stability, and snapshot hydration.

**Files:**
- Create: `src/features/search/scanLive.ts` (pure reducer `foldScanEvent` + `assignSlots`)
- Create: `src/features/search/useScanLive.ts` (the hook wiring `subscribeSearch` → reducer)
- Test: `src/features/search/scanLive.test.ts`

**Interfaces:**
- Consumes: `subscribeSearch` (`client.ts`), `SseEvent` / `ScanFrame` / `SourceEventData` / `JobPhaseData` (`@/types`).
- Produces:
  - `type LiveState = { sources: SourceEventData[]; activeJobs: (JobPhaseData & { slot: number })[]; counts: { scored: number; queued: number; total: number } }`
  - `foldScanEvent(prev: LiveState, event: SseEvent): LiveState` (pure; ignores `progress`/`job`/`done`/`error` for the live frame)
  - `useScanLive(runId: string | null): { state: LiveState; status: "idle"|"running"|"done"|"error" }`

- [ ] **Step 1: Write the failing reducer tests**

```ts
import { describe, expect, it } from "vitest";
import { foldScanEvent, EMPTY_LIVE } from "./scanLive";

const src = (id: string, status: any) => ({ event: "source" as const, data: { sourceId: id, name: id, status } });
const jp = (id: string, phase: any) => ({ event: "jobPhase" as const, data: { jobId: id, title: id, company: "C", source: "s", phase } });

describe("foldScanEvent", () => {
  it("hydrates from a snapshot", () => {
    const s = foldScanEvent(EMPTY_LIVE, { event: "snapshot", data: { sources: [{ sourceId: "s1", name: "GH", status: "done", found: 5 }], activeJobs: [{ jobId: "j1", title: "t", company: "c", source: "s1", phase: "scoring" }], counts: { scored: 0, queued: 1, total: 1 } } });
    expect(s.sources).toHaveLength(1);
    expect(s.activeJobs[0].slot).toBe(0);
  });
  it("is idempotent — a duplicate source delta doesn't duplicate the row", () => {
    let s = foldScanEvent(EMPTY_LIVE, src("s1", "fetching"));
    s = foldScanEvent(s, src("s1", "fetching"));
    s = foldScanEvent(s, src("s1", "done"));
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0].status).toBe("done");
  });
  it("folds score progress deltas into counts even without a snapshot", () => {
    let s = foldScanEvent(EMPTY_LIVE, { event: "progress", data: { stage: "score", current: 6, total: 30, label: "6/30 scored" } });
    expect(s.counts).toEqual({ scored: 6, total: 30, queued: 24 });
    s = foldScanEvent(s, { event: "progress", data: { stage: "sources", current: 3, total: 8, label: "…" } }); // non-score ignored
    expect(s.counts.scored).toBe(6);
  });
  it("keeps a job's slot stable across phase changes and frees it on done", () => {
    let s = foldScanEvent(EMPTY_LIVE, jp("j1", "fetching"));
    let s2 = foldScanEvent(s, jp("j2", "fetching"));
    const j1slot = s2.activeJobs.find((j) => j.jobId === "j1")!.slot;
    s2 = foldScanEvent(s2, jp("j1", "scoring"));
    expect(s2.activeJobs.find((j) => j.jobId === "j1")!.slot).toBe(j1slot); // stable
    s2 = foldScanEvent(s2, jp("j1", "done"));
    expect(s2.activeJobs.find((j) => j.jobId === "j1")).toBeUndefined(); // freed
    // j3 reuses j1's freed slot
    s2 = foldScanEvent(s2, jp("j3", "fetching"));
    expect(s2.activeJobs.find((j) => j.jobId === "j3")!.slot).toBe(j1slot);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the reducer** in `src/features/search/scanLive.ts`:

```ts
import type { SseEvent, SourceEventData, JobPhaseData } from "@/types";

export type LiveJob = JobPhaseData & { slot: number };
export interface LiveState {
  sources: SourceEventData[];
  activeJobs: LiveJob[];
  counts: { scored: number; queued: number; total: number };
}
export const EMPTY_LIVE: LiveState = { sources: [], activeJobs: [], counts: { scored: 0, queued: 0, total: 0 } };

function lowestFreeSlot(jobs: LiveJob[]): number {
  const taken = new Set(jobs.map((j) => j.slot));
  let s = 0;
  while (taken.has(s)) s++;
  return s;
}

export function foldScanEvent(prev: LiveState, event: SseEvent): LiveState {
  switch (event.event) {
    case "snapshot": {
      // Absolute hydrate; assign slots in array order (stable for a given frame).
      const activeJobs = event.data.activeJobs.map((j, i) => ({ ...j, slot: i }));
      return { sources: event.data.sources, activeJobs, counts: event.data.counts };
    }
    case "source": {
      const sources = prev.sources.some((s) => s.sourceId === event.data.sourceId)
        ? prev.sources.map((s) => (s.sourceId === event.data.sourceId ? event.data : s))
        : [...prev.sources, event.data];
      return { ...prev, sources };
    }
    case "jobPhase": {
      const d = event.data;
      if (d.phase === "done" || d.phase === "error") {
        return { ...prev, activeJobs: prev.activeJobs.filter((j) => j.jobId !== d.jobId) };
      }
      const existing = prev.activeJobs.find((j) => j.jobId === d.jobId);
      const slot = existing ? existing.slot : lowestFreeSlot(prev.activeJobs);
      const activeJobs = existing
        ? prev.activeJobs.map((j) => (j.jobId === d.jobId ? { ...d, slot } : j))
        : [...prev.activeJobs, { ...d, slot }];
      return { ...prev, activeJobs };
    }
    case "progress": {
      // B5: counts come from the existing (idempotent, state-setting) score
      // progress deltas — a snapshot only arrives if the client subscribed after
      // the first frame, which the normal Feed→/scans/:id flow does NOT. The
      // `score` stage's {current,total} are absolute, so this stays idempotent.
      if (event.data.stage !== "score") return prev;
      const total = event.data.total;
      const scored = event.data.current;
      return { ...prev, counts: { scored, total, queued: Math.max(0, total - scored) } };
    }
    default:
      return prev; // job/done/error don't affect the live frame
  }
}
```

> **Idempotency note:** `progress.score.current` is the pool's `doneCount` (scored + unscored + errored + capped), a monotonic absolute — folding it is safe even alongside a snapshot's counts, because both set absolute state. `counts.scored` here means "settled", matching the `{n}/{total} scored` progress label already emitted by M0.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Build the hook** `src/features/search/useScanLive.ts` — subscribe via `subscribeSearch(runId, onEvent)`, fold each event into `LiveState` with `useReducer(foldScanEvent, EMPTY_LIVE)` (dispatch the raw `SseEvent`), track a coarse `status` from `done`/`error`, and unsubscribe on unmount / runId change. Mirror `useScanRun`'s subscribe lifecycle (`useScanRun.ts:48-74,108-110`).

```ts
export function useScanLive(runId: string | null): { state: LiveState; status: "idle" | "running" | "done" | "error" } {
  const [state, dispatch] = React.useReducer(foldScanEvent, EMPTY_LIVE);
  const [status, setStatus] = React.useState<"idle" | "running" | "done" | "error">("idle");
  React.useEffect(() => {
    if (!runId) return;
    setStatus("running");
    const unsub = subscribeSearch(runId, (event) => {
      dispatch(event);
      if (event.event === "done") setStatus("done");
      if (event.event === "error") setStatus("error");
    });
    return () => unsub();
  }, [runId]);
  return { state, status };
}
```

(`useReducer` with a stream dispatch is safe here — `foldScanEvent` is pure and idempotent.)

- [ ] **Step 6: Commit**

```bash
git add src/features/search/scanLive.ts src/features/search/useScanLive.ts src/features/search/scanLive.test.ts
git commit -m "feat(search): useScanLive reducer + client lane assignment"
```

---

### Task 6: `SourceStrip` + `ScanLanes` compositions

**Model · effort · goal:** `executor` (sonnet) · medium · Two presentational compositions render the live frame — `SourceStrip` (per-source chips with fetching/done/error state) and `ScanLanes` (one lane per active job showing its sub-phase glyph + title/company + a counts row) — reusing `StageGlyph` and the `caliber-pulse`/`caliber-spin` keyframes; dom tests prove phase rendering.

**Files:**
- Create: `src/caliber-ui/compositions/Scans/SourceStrip.tsx`
- Create: `src/caliber-ui/compositions/Scans/ScanLanes.tsx`
- Test: `src/caliber-ui/compositions/Scans/ScanLanes.dom.test.tsx`

**Interfaces:**
- Consumes: `LiveState` (`features/search/scanLive`), `StageGlyph` (`compositions/Feed/ScanProgress`), `Tag`/`Card` (`caliber-ui`), `caliber-spin`/`caliber-pulse` (`styles/tokens.css`).
- Produces:
  - `SourceStrip({ sources }: { sources: SourceEventData[] })`
  - `ScanLanes({ activeJobs, counts }: { activeJobs: LiveJob[]; counts: LiveState["counts"] })`

- [ ] **Step 1: Write the failing dom test**

```tsx
it("renders a lane per active job with its phase label and a counts row", () => {
  render(<ScanLanes activeJobs={[
    { jobId: "j1", title: "DE", company: "Acme", source: "s", phase: "scoring", slot: 0 },
    { jobId: "j2", title: "SRE", company: "Beta", source: "s", phase: "readingJD", slot: 1 },
  ]} counts={{ scored: 4, queued: 24, total: 30 }} />);
  expect(screen.getByText("DE")).toBeInTheDocument();
  expect(screen.getByText(/scoring/i)).toBeInTheDocument();
  expect(screen.getByText(/reading JD/i)).toBeInTheDocument();
  expect(screen.getByText(/4\s*\/\s*30/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Build both components.** `ScanLanes`: sort `activeJobs` by `slot`, render a `Card` row per lane — a phase glyph (map `fetching/readingJD/scoring/rescoring` → an `active` `StageGlyph` with a `caliber-spin` icon; distinguish phases by a small text label from a `PHASE_LABEL` record `{ fetching:"Fetching", readingJD:"Reading JD", scoring:"Scoring", rescoring:"Re-scoring" }`), title/company, and a `caliber-pulse` on the active row. Counts row: `{counts.scored}/{counts.total} · {counts.queued} queued`. `SourceStrip`: a flex row of `Tag`s, tone by status (`done`→`good`/`verified`, `fetching`→`neutral` + `caliber-spin`, `error`→`danger`), showing `name` + `found`. Pure props; no fetching.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/caliber-ui/compositions/Scans/SourceStrip.tsx src/caliber-ui/compositions/Scans/ScanLanes.tsx src/caliber-ui/compositions/Scans/ScanLanes.dom.test.tsx
git commit -m "feat(scans): SourceStrip + ScanLanes live compositions"
```

---

### Task 7: Wire the live view into `/scans/:id`

**Model · effort · goal:** `executor` (sonnet) · medium · A running `/scans/:id` renders `SourceStrip` + `ScanLanes` fed by `useScanLive` (replacing the M1 coarse `ScanProgress` bridge); a terminal run still renders `ScanReplay`; when a live run reaches `done`, the page refetches the detail and swaps to the replay; a dom test proves the running→terminal swap.

**Files:**
- Modify: `src/app/(app)/scans/[id]/page.tsx` (running branch → live view; transition on `done`)
- Test: `src/app/(app)/scans/[id]/page.dom.test.tsx` (add/adjust the running-view case)

**Interfaces:**
- Consumes: `useScanLive` (Task 5), `SourceStrip`/`ScanLanes` (Task 6), `getScanDetail`/`ScanReplay` (M1), `useScanLive().status`.
- Produces: none new.

- [ ] **Step 1: Adjust the failing page test** — mock a running detail + a `useScanLive` returning two active jobs; assert lanes render (not the coarse bar). Then simulate `status:"done"` and assert `getScanDetail` is refetched and `ScanReplay` renders.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Rewire the running branch.** In `page.tsx`, call `useScanLive` **unconditionally at the top level** — never inside the `status === "running"` branch (rules of hooks; `useScanLive` is null-safe by design). Pass `null` until the run is actually running:

```tsx
    // top level of the page component — NOT inside a conditional
    const live = useScanLive(detail?.status === "running" ? id : null);
    React.useEffect(() => {
      if (live.status === "done" || live.status === "error") void reload(); // refetch getScanDetail → detail flips terminal → ScanReplay
    }, [live.status]);

    // in render: if detail.status === "running" →
    //   header (résumé/persona/elapsed) + <SourceStrip sources={live.state.sources} /> + <ScanLanes activeJobs={live.state.activeJobs} counts={live.state.counts} />
    // else → <ScanReplay detail={detail} />
```

Remove the M1 `useScanRun`+`ScanProgress` coarse bridge from this page (that was the explicit M1 placeholder). Terminal branch (`ScanReplay`) is unchanged.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/scans/[id]/page.tsx" "src/app/(app)/scans/[id]/page.dom.test.tsx"
git commit -m "feat(scans): live concurrency lanes on running /scans/:id"
```

---

### Task 8: Full-gate + contract/inventory regen

**Model · effort · goal:** `executor` (sonnet) · low · `npm run check` is fully green; the API contract lists the new SSE events and the component inventory lists `SourceStrip`/`ScanLanes`.

- [ ] **Step 1: Regenerate the contract** (new `SseEvent` variants + `ScanFrame`). Commit `docs/architecture/api-contract.md`.

- [ ] **Step 2: Add `SourceStrip`, `ScanLanes` to `docs/architecture/component-inventory.md`.**

- [ ] **Step 3: Run the full gate**

Run: `npm run check`
Expected: PASS — typecheck (the `unknown` frame slot casts cleanly; `foldScanEvent`'s `SseEvent` switch is exhaustive), full vitest (M0/M1/M2 suites), contract check, build.

- [ ] **Step 4: Manual smoke (optional but recommended)** — start the dev server, run a scan from `/scans`, confirm lanes animate and the view swaps to the replay on completion. Use the `run` skill.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/api-contract.md docs/architecture/component-inventory.md
git commit -m "docs(scans): regenerate contract + inventory for M2 live view"
```

---

## Deferred out of M2 (tracked, intentional)

- **Per-lane expandable event log** (a firehose of each job's raw sub-events) — spec D3 excludes it from v1.
- **"Cancel scan" button** — a stretch note in the spec; the abort signal is already threaded (M0), so a cancel control is a small follow-up but out of this plan's scope.
- **Server-assigned lanes** — rejected; lanes are pure client presentation (constraint above).

## Self-Review

- **Spec coverage (§4.4):** new idempotent `source`/`jobPhase` events → Tasks 1+3; register names in Zod union / `RunEvent` / client `eventNames` → Task 1; `currentFrame` owned in `run.ts`, opaque slot on `RunHandle`, registry stays generic → Tasks 2+3; `snapshot`-on-subscribe before live deltas → Task 4; `useScanLive` reducer + client lane assignment → Task 5; counts fed by `progress` deltas → Task 5 (B5); `SourceStrip` + `ScanLanes` reusing `StageGlyph`/motion + counts row → Task 6; wired into running `/scans/:id`, replacing the M1 bridge → Task 7. Phase mapping (liveness=fetching, jdFacts=readingJD, matchScore=scoring, escalation=rescoring; legitimacy folds into done with the tier) → Task 3 Steps 5–6.
- **Correctness fixes verified:** the frame's counts live in `scoreTopCandidates`, not `runFanOut`, so the frame is a **`ScanFrameBuilder` passed into `scoreTopCandidates`** (B4, Task 3) — not a cross-function closure; `counts` are folded from the existing `progress.score` deltas because a `snapshot` often never arrives on the normal Feed→detail nav (B5, Task 5); `useScanLive(id)` is called **unconditionally at top level** with a `null` arg when not running (S5, Task 7) — never inside a conditional.
- **Grounded facts (corrected against code):** numeric fit = `scoreRow.score` (Task 3 Step 6); source display column = `sources.name`, no `label`, no `?? id` fallback (Task 3 Step 4). SseEvent union is at `:288-293`, `RunEvent` at `:15-19`, `eventNames` at `:36` (verified).
- **Placeholder scan:** none — reducer, route, registry, and builder steps show full code; the `run.ts` emit steps show the exact wrapping code around existing (un-replaced) logic. One pre-write grep remains (an existing SSE-read test helper in Task 4).
- **Type consistency:** `SourceEventData`/`JobPhaseData`/`ScanFrame` (Task 1) are the single source used by the `ScanFrameBuilder` + emitters (Task 3), the frame slot (Task 2/3), the snapshot line (Task 4), and the reducer (Task 5) — same field names throughout (`sourceId`, `jobId`, `phase`, `legitimacyTier`, `fit`). `foldScanEvent`/`LiveState`/`LiveJob.slot` (Task 5) match `ScanLanes`/`SourceStrip` props (Task 6). `handle.setFrame`/`handle.frame` (Task 2) match the builder writer (Task 3) and route reader (Task 4). Phase enum is identical in the Zod schema (Task 1), `scoreJob.onPhase` (Task 3), and `PHASE_LABEL` (Task 6).
