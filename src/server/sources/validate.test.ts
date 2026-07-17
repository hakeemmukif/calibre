import { describe, expect, it, vi } from "vitest";
import { validateSlugs } from "./validate";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("validateSlugs", () => {
  it("200 greenhouse: returns ok with jobCount + lastValidatedAt, hitting the boards-api endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { jobs: [{ id: 1 }, { id: 2 }] }));
    const now = () => 1_752_700_000_000;

    const [result] = await validateSlugs([{ slug: "acme", ats: "greenhouse" }], { fetch: fetchMock, now });

    expect(result).toEqual({ ok: true, jobCount: 2, lastValidatedAt: 1_752_700_000_000 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
      expect.anything(),
    );
  });

  it("200 lever: returns ok with jobCount from the bare postings array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, [{ id: "a" }, { id: "b" }, { id: "c" }]));
    const now = () => 1_752_700_000_001;

    const [result] = await validateSlugs([{ slug: "acme", ats: "lever" }], { fetch: fetchMock, now });

    expect(result).toEqual({ ok: true, jobCount: 3, lastValidatedAt: 1_752_700_000_001 });
    expect(fetchMock).toHaveBeenCalledWith("https://api.lever.co/v0/postings/acme", expect.anything());
  });

  it("200 ashby: returns ok with jobCount, hitting the posting-api endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { jobs: [{ id: 1 }] }));
    const now = () => 1_752_700_000_002;

    const [result] = await validateSlugs([{ slug: "acme", ats: "ashby" }], { fetch: fetchMock, now });

    expect(result).toEqual({ ok: true, jobCount: 1, lastValidatedAt: 1_752_700_000_002 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
      expect.anything(),
    );
  });

  it("404: returns a not-ok result rather than throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not found" }));

    const [result] = await validateSlugs([{ slug: "ghost-co", ats: "greenhouse" }], {
      fetch: fetchMock,
      now: () => 0,
    });

    expect(result).toEqual({ ok: false, status: 404, reason: "not_found" });
  });

  it("403 and 429: not-ok with an explicit reason, never treated as ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}));

    const results = await validateSlugs(
      [
        { slug: "forbidden-co", ats: "lever" },
        { slug: "throttled-co", ats: "lever" },
      ],
      { fetch: fetchMock, now: () => 0, concurrencyPerHost: 1 },
    );

    expect(results).toEqual([
      { ok: false, status: 403, reason: "forbidden" },
      { ok: false, status: 429, reason: "rate_limited" },
    ]);
  });

  it("greenhouse: candidates are accepted regardless of which public host (boards.greenhouse.io vs job-boards.greenhouse.io) the slug was discovered on — validation always hits the canonical boards-api host", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, { jobs: [] }));

    const results = await validateSlugs(
      [
        { slug: "seen-on-boards-host", ats: "greenhouse" },
        { slug: "seen-on-job-boards-host", ats: "greenhouse" },
      ],
      { fetch: fetchMock, now: () => 0 },
    );

    expect(results).toEqual([
      { ok: true, jobCount: 0, lastValidatedAt: 0 },
      { ok: true, jobCount: 0, lastValidatedAt: 0 },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://boards-api.greenhouse.io/v1/boards/seen-on-boards-host/jobs?content=true",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://boards-api.greenhouse.io/v1/boards/seen-on-job-boards-host/jobs?content=true",
      expect.anything(),
    );
  });

  it("per-host concurrency cap: never exceeds the configured max in-flight requests to the same host", async () => {
    const maxInFlightSeen: Record<string, number> = {};
    const inFlight: Record<string, number> = {};

    const fetchMock = vi.fn(async (url: string) => {
      const host = new URL(url).host;
      inFlight[host] = (inFlight[host] ?? 0) + 1;
      maxInFlightSeen[host] = Math.max(maxInFlightSeen[host] ?? 0, inFlight[host]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight[host] -= 1;
      return jsonResponse(200, { jobs: [] });
    });

    const candidates = Array.from({ length: 10 }, (_, i) => ({ slug: `co-${i}`, ats: "greenhouse" as const }));

    await validateSlugs(candidates, { fetch: fetchMock, now: () => 0, concurrencyPerHost: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(maxInFlightSeen["boards-api.greenhouse.io"]).toBeLessThanOrEqual(3);
    expect(maxInFlightSeen["boards-api.greenhouse.io"]).toBeGreaterThan(1); // proves it actually parallelizes, not serial
  });

  it("per-host concurrency cap applies independently per vendor host", async () => {
    const inFlight: Record<string, number> = {};
    const maxInFlightSeen: Record<string, number> = {};

    const fetchMock = vi.fn(async (url: string) => {
      const host = new URL(url).host;
      inFlight[host] = (inFlight[host] ?? 0) + 1;
      maxInFlightSeen[host] = Math.max(maxInFlightSeen[host] ?? 0, inFlight[host]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight[host] -= 1;
      return jsonResponse(200, host === "api.lever.co" ? [] : { jobs: [] });
    });

    const candidates = [
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `gh-${i}`, ats: "greenhouse" as const })),
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `lv-${i}`, ats: "lever" as const })),
    ];

    await validateSlugs(candidates, { fetch: fetchMock, now: () => 0, concurrencyPerHost: 2 });

    expect(maxInFlightSeen["boards-api.greenhouse.io"]).toBeLessThanOrEqual(2);
    expect(maxInFlightSeen["api.lever.co"]).toBeLessThanOrEqual(2);
  });

  it("a rejected fetch (network error) becomes a not-ok result instead of crashing the whole batch", async () => {
    // Regression for S1: ECONNRESET/DNS failure/timeout on one candidate must
    // not discard already-completed results for the others.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1 }] }))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { jobs: [{ id: 1 }, { id: 2 }] }));

    const results = await validateSlugs(
      [
        { slug: "ok-co", ats: "greenhouse" },
        { slug: "flaky-co", ats: "greenhouse" },
        { slug: "also-ok-co", ats: "greenhouse" },
      ],
      { fetch: fetchMock, now: () => 0, concurrencyPerHost: 1 },
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, jobCount: 1, lastValidatedAt: 0 });
    expect(results[1]).toEqual({ ok: false, reason: "network_error", detail: "ECONNRESET" });
    expect(results[1]).not.toHaveProperty("status");
    expect(results[2]).toEqual({ ok: true, jobCount: 2, lastValidatedAt: 0 });
  });

  it("limiter does not deadlock or leak slots when some fetches reject", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("reject-me")) {
        throw new Error("timeout");
      }
      return jsonResponse(200, { jobs: [] });
    });

    const candidates = [
      { slug: "reject-me-1", ats: "greenhouse" as const },
      { slug: "reject-me-2", ats: "greenhouse" as const },
      { slug: "ok-1", ats: "greenhouse" as const },
      { slug: "ok-2", ats: "greenhouse" as const },
      { slug: "ok-3", ats: "greenhouse" as const },
    ];

    const results = await validateSlugs(candidates, { fetch: fetchMock, now: () => 0, concurrencyPerHost: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({ ok: false, reason: "network_error", detail: "timeout" });
    expect(results[1]).toEqual({ ok: false, reason: "network_error", detail: "timeout" });
    expect(results[2]).toEqual({ ok: true, jobCount: 0, lastValidatedAt: 0 });
    expect(results[3]).toEqual({ ok: true, jobCount: 0, lastValidatedAt: 0 });
    expect(results[4]).toEqual({ ok: true, jobCount: 0, lastValidatedAt: 0 });
  });

  it("rejects an unknown ats kind loudly instead of silently skipping it", async () => {
    const fetchMock = vi.fn();

    await expect(
      // @ts-expect-error — deliberately invalid ats to assert the fail-loud boundary check
      validateSlugs([{ slug: "acme", ats: "workday" }], { fetch: fetchMock, now: () => 0 }),
    ).rejects.toThrow(/workday/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
