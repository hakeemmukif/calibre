import { describe, expect, it, beforeEach } from "vitest";
import { checkRegisterLimit, __resetRegisterLimitForTests } from "./registerLimit";

beforeEach(() => {
  __resetRegisterLimitForTests();
});

describe("checkRegisterLimit", () => {
  it("allows 3 registrations from one IP then denies the 4th", () => {
    const ip = "203.0.113.9";
    expect(checkRegisterLimit(ip)).toBe(true);
    expect(checkRegisterLimit(ip)).toBe(true);
    expect(checkRegisterLimit(ip)).toBe(true);
    expect(checkRegisterLimit(ip)).toBe(false);
  });

  it("tracks a different IP in its own bucket, unaffected by another IP's count", () => {
    const ipA = "203.0.113.9";
    const ipB = "203.0.113.10";
    expect(checkRegisterLimit(ipA)).toBe(true);
    expect(checkRegisterLimit(ipA)).toBe(true);
    expect(checkRegisterLimit(ipA)).toBe(true);
    expect(checkRegisterLimit(ipA)).toBe(false);
    expect(checkRegisterLimit(ipB)).toBe(true);
  });

  it("re-allows once the fixed window has elapsed", () => {
    const ip = "203.0.113.9";
    const start = 1_000_000;
    expect(checkRegisterLimit(ip, start)).toBe(true);
    expect(checkRegisterLimit(ip, start)).toBe(true);
    expect(checkRegisterLimit(ip, start)).toBe(true);
    expect(checkRegisterLimit(ip, start)).toBe(false);
    const afterWindow = start + 60 * 60_000;
    expect(checkRegisterLimit(ip, afterWindow)).toBe(true);
  });
});
