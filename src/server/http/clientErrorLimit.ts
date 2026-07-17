// Per-IP limit for the crash beacon (pre-launch hardening Task 4): 5/minute
// fixed window, in-memory — same single-process assumption and idiom as
// src/server/auth/registerLimit.ts. Keyed off x-forwarded-for because behind
// the host Caddy every socket IS the proxy; without XFF the limiter would
// throttle all friends as one bucket.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

type Bucket = { windowStart: number; count: number };
const g = globalThis as unknown as { __caliberClientErrorLimiter?: Map<string, Bucket> };
g.__caliberClientErrorLimiter ??= new Map();
const buckets = g.__caliberClientErrorLimiter;

export function checkClientErrorLimit(ip: string, now = Date.now()): boolean {
  const b = buckets.get(ip);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

export function __resetClientErrorLimitForTests(): void {
  buckets.clear();
}
