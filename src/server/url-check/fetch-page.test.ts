// Tier-1 acquisition unit tests (pasted-job-ingestion spec §7). global fetch
// is stubbed per describe.test.ts's precedent; ./ssrf is mocked so these
// stay hermetic (no real DNS lookups) and assert assertPublicHttpUrl is
// re-invoked on every redirect hop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpUrl } from "./ssrf";
import { fetchPageText } from "./fetch-page";

vi.mock("./ssrf", () => ({
  assertPublicHttpUrl: vi.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(reason: string) {
      super(reason);
      this.name = "SsrfBlockedError";
    }
  },
}));

function htmlPage(bodyText: string, title = "Job"): string {
  return `<html><head><title>${title}</title></head><body>${bodyText}</body></html>`;
}

describe("fetchPageText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(assertPublicHttpUrl).mockClear();
  });

  it("re-validates assertPublicHttpUrl on every redirect hop and follows Location to a final html response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com/hop2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com/hop3" } }))
      .mockResolvedValueOnce(
        new Response(htmlPage("Job description content. ".repeat(20)), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPageText("https://example.com/job");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(assertPublicHttpUrl).toHaveBeenCalledTimes(3);
    expect(assertPublicHttpUrl).toHaveBeenNthCalledWith(1, new URL("https://example.com/job"));
    expect(assertPublicHttpUrl).toHaveBeenNthCalledWith(2, new URL("https://example.com/hop2"));
    expect(assertPublicHttpUrl).toHaveBeenNthCalledWith(3, new URL("https://example.com/hop3"));
  });

  it("aborts the stream and reports oversize once the body exceeds MAX_BYTES", async () => {
    const chunk = new Uint8Array(1_500_000).fill(97);
    let reads = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockImplementation(async () => {
        reads += 1;
        if (reads > 2) return { done: true, value: undefined };
        return { done: false, value: chunk };
      }),
      cancel,
    };
    const res = {
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const result = await fetchPageText("https://example.com/job");

    expect(result).toEqual({ ok: false, reason: "oversize" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
