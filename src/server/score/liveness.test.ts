import { describe, expect, it, vi } from "vitest";
import { probeLiveness, probeLivenessDeep } from "./liveness";

function jsonRes(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("probeLiveness", () => {
  it("200 -> active", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(200));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("active");
  });

  it("404 -> expired", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(404));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("expired");
  });

  it("410 -> expired", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(410));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("expired");
  });

  it("500 -> uncertain", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(500));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("uncertain");
  });

  it("network error -> uncertain", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("uncertain");
  });

  it("follows a redirect chain within the hop budget", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(302, { location: "https://example.com/next" }))
      .mockResolvedValueOnce(jsonRes(200));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("active");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up as uncertain once the redirect budget is exceeded", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(302, { location: "https://example.com/loop" }));
    expect(await probeLiveness("https://example.com/job", { fetchFn, maxRedirects: 2 })).toBe("uncertain");
    expect(fetchFn).toHaveBeenCalledTimes(3); // hop 0,1,2
  });

  it("a redirect with no Location header -> uncertain", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(302));
    expect(await probeLiveness("https://example.com/job", { fetchFn })).toBe("uncertain");
  });
});

describe("probeLivenessDeep", () => {
  it("returns the plain-probe result without ever importing/launching Playwright when the env flag is unset", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(500));
    const original = process.env.CALIBER_LIVENESS_PLAYWRIGHT;
    delete process.env.CALIBER_LIVENESS_PLAYWRIGHT;
    try {
      expect(await probeLivenessDeep("https://example.com/job", { fetchFn })).toBe("uncertain");
    } finally {
      if (original !== undefined) process.env.CALIBER_LIVENESS_PLAYWRIGHT = original;
    }
  });

  it("skips the Playwright fallback entirely when the plain probe already resolved", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(200));
    expect(await probeLivenessDeep("https://example.com/job", { fetchFn })).toBe("active");
  });
});
