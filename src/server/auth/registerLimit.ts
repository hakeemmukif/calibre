// Per-IP registration limit (membership spec §4.5.3): 3/hour fixed window,
// in-memory. Correct because the app is one process by design (same
// assumption as the SSE run registry, src/server/runs/registry.ts).
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 3;

type Bucket = { windowStart: number; count: number };
const g = globalThis as unknown as { __caliberRegisterLimiter?: Map<string, Bucket> };
g.__caliberRegisterLimiter ??= new Map();
const buckets = g.__caliberRegisterLimiter;

export function checkRegisterLimit(ip: string, now = Date.now()): boolean {
  const b = buckets.get(ip);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

export function __resetRegisterLimitForTests(): void {
  buckets.clear();
}
