export async function waitFor<T>(fn: () => Promise<T>, isDone: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fn();
    if (isDone(value)) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
