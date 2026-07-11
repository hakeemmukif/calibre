// Next 15 startup hook (docs.nextjs.org "Instrumentation" — stable, no
// experimental.instrumentationHook flag needed). system-architecture.md §6
// decision 2: "A restart kills a run (status running → mark stale on boot)."
// `markStaleRunningOnBoot` was only unit-tested until now — nothing called
// it at process start, so a leftover `running` row from a killed process
// stayed `running` forever. Runs only in the Node runtime (the edge runtime
// also calls `register()`, but this touches the DB, which edge can't do).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { markStaleRunningOnBoot } = await import("@/server/runs/registry");
    await markStaleRunningOnBoot();
  }
}
