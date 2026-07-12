import { afterEach, describe, expect, it, vi } from "vitest";

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsMock.lookup }));

const { assertPublicHttpUrl, isDeniedIp, SsrfBlockedError } = await import("./ssrf");

afterEach(() => {
  dnsMock.lookup.mockReset();
});

describe("isDeniedIp", () => {
  const denied: [string, string][] = [
    ["127.0.0.1", "v4 loopback"],
    ["10.0.0.1", "v4 private 10/8"],
    ["172.16.0.1", "v4 private 172.16/12 lower bound"],
    ["172.31.255.255", "v4 private 172.16/12 upper bound"],
    ["192.168.1.1", "v4 private 192.168/16"],
    ["169.254.1.1", "v4 link-local"],
    ["169.254.169.254", "v4 metadata"],
    ["0.0.0.0", "v4 unspecified"],
    ["100.64.0.1", "v4 CGNAT lower bound"],
    ["100.127.255.255", "v4 CGNAT upper bound"],
    ["::1", "v6 loopback"],
    ["fc00::", "v6 unique-local lower bound"],
    ["fc00::1", "v6 unique-local"],
    ["fdff:ffff::1", "v6 unique-local upper bound"],
    ["fe80::", "v6 link-local lower bound"],
    ["fe80::1", "v6 link-local"],
    ["febf:ffff::1", "v6 link-local upper bound"],
    ["::ffff:127.0.0.1", "v6 mapped v4 loopback"],
    ["::ffff:169.254.169.254", "v6 mapped v4 metadata"],
  ];

  it.each(denied)("denies %s (%s)", (ip) => {
    expect(isDeniedIp(ip)).toBe(true);
  });

  const allowed: [string, string][] = [
    ["8.8.8.8", "v4 public"],
    ["1.1.1.1", "v4 public"],
    ["172.15.255.255", "v4 just below private 172.16/12"],
    ["172.32.0.0", "v4 just above private 172.16/12"],
    ["100.63.255.255", "v4 just below CGNAT"],
    ["100.128.0.0", "v4 just above CGNAT"],
    ["2001:4860:4860::8888", "v6 public"],
    ["fe00::1", "v6 just below link-local /10"],
    ["fec0::1", "v6 just above link-local /10"],
    ["::ffff:8.8.8.8", "v6 mapped v4 public"],
  ];

  it.each(allowed)("allows %s (%s)", (ip) => {
    expect(isDeniedIp(ip)).toBe(false);
  });

  it("denies a string that is not a valid IP literal (fail closed)", () => {
    expect(isDeniedIp("not-an-ip")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects a non-http(s) scheme without resolving DNS", async () => {
    await expect(assertPublicHttpUrl(new URL("file:///etc/passwd"))).rejects.toThrow(SsrfBlockedError);
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it("resolves and passes when every A/AAAA record is public", async () => {
    dnsMock.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    await expect(assertPublicHttpUrl(new URL("https://example.com/job"))).resolves.toBeUndefined();
    expect(dnsMock.lookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks when any resolved record is denied, even if others are public", async () => {
    dnsMock.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(assertPublicHttpUrl(new URL("https://example.com/job"))).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks decimal-literal hosts because the check runs on the resolved address, not the host string", async () => {
    // e.g. http://2130706433/ is the decimal form of 127.0.0.1 — getaddrinfo
    // resolves it before we ever inspect the string, so the denylist still catches it.
    dnsMock.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicHttpUrl(new URL("https://2130706433/job"))).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks when DNS resolves to no records", async () => {
    dnsMock.lookup.mockResolvedValue([]);
    await expect(assertPublicHttpUrl(new URL("https://example.com/job"))).rejects.toThrow(SsrfBlockedError);
  });

  it("SsrfBlockedError carries a distinct .reason per failure category", async () => {
    await expect(assertPublicHttpUrl(new URL("file:///etc/passwd"))).rejects.toMatchObject({
      reason: expect.stringContaining("scheme"),
    });

    dnsMock.lookup.mockResolvedValue([]);
    await expect(assertPublicHttpUrl(new URL("https://example.com/job"))).rejects.toMatchObject({
      reason: expect.stringContaining("no DNS records"),
    });

    dnsMock.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicHttpUrl(new URL("https://example.com/job"))).rejects.toMatchObject({
      reason: expect.stringContaining("127.0.0.1"),
    });
  });
});
