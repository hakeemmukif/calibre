// Tier-1 acquisition unit tests (pasted-job-ingestion spec §7). global fetch
// is stubbed per describe.test.ts's precedent; ./ssrf is mocked so these
// stay hermetic (no real DNS lookups) and assert assertPublicHttpUrl is
// re-invoked on every redirect hop.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpUrl } from "./ssrf";
import { fetchPageText, MAX_TEXT_CHARS, MIN_TEXT_CHARS } from "./fetch-page";

const FIXTURES = join(__dirname, "__fixtures__");

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

  it("returns error after exhausting every redirect hop when every response redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.com/next" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPageText("https://example.com/job");

    expect(result).toEqual({ ok: false, reason: "error" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // MAX_REDIRECTS (3) + 1
  });

  it("rejects a non-html/plain content-type as blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4 binary junk. ".repeat(30), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      ),
    );

    const result = await fetchPageText("https://example.com/job.pdf");

    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("captures the <title> tag as pageTitle alongside the stripped text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(htmlPage("Job description content. ".repeat(20), "Senior Engineer &amp; Lead"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    const result = await fetchPageText("https://example.com/job");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.pageTitle).toBe("Senior Engineer & Lead");
    expect(result.text).toContain("Job description content.");
  });

  it("reports oversize when the stripped text exceeds MAX_TEXT_CHARS while comfortably under the byte cap (spec §15)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        // ~52,000 stripped chars — well past the 40,000-char MAX_TEXT_CHARS
        // cap but a fraction of the 2,000,000-byte MAX_BYTES cap, so this
        // exercises the char-cap branch specifically, not the byte cap.
        new Response(htmlPage("Job description content. ".repeat(2000)), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await fetchPageText("https://example.com/job");

    expect(result).toEqual({ ok: false, reason: "oversize" });
  });

  it("flags login-wall boilerplate as blocked even when the stripped text clears MIN_TEXT_CHARS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(htmlPage("Sign in to continue viewing this page. ".repeat(20)), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await fetchPageText("https://example.com/job");

    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("rewrites a LinkedIn /jobs/view/{id} url to the guest endpoint before fetching and SSRF-checking it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(htmlPage("Job description content. ".repeat(20)), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const guestUrl = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365";

    const result = await fetchPageText("https://www.linkedin.com/jobs/view/4388552365/");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(guestUrl, expect.anything());
    expect(assertPublicHttpUrl).toHaveBeenCalledWith(new URL(guestUrl));
  });

  it("marker scoping: login-wall text from the guest endpoint is NOT blocked, but the same text from a non-guest url IS", async () => {
    const body = htmlPage("Join LinkedIn to see this posting. ".repeat(20));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const guestResult = await fetchPageText("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365");
    expect(guestResult.ok).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const nonGuestResult = await fetchPageText("https://example.com/job");
    expect(nonGuestResult).toEqual({ ok: false, reason: "blocked" });
  });

  it("re-normalizes a redirect hop that lands on a LinkedIn job url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.linkedin.com/jobs/view/4388552365" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(htmlPage("Job description content. ".repeat(20)), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPageText("https://short.link/abc");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365",
      expect.anything(),
    );
  });

  it("guest endpoint 404 -> error, not blocked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));

    const result = await fetchPageText("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365");

    expect(result).toEqual({ ok: false, reason: "error" });
  });

  it("sends the browser User-Agent and Accept-Language on every fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(htmlPage("Job description content. ".repeat(20)), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchPageText("https://example.com/job");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/job",
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": expect.stringContaining("Chrome"),
          "accept-language": "en-US,en;q=0.9",
        }),
      }),
    );
  });

  it("real pinned LinkedIn guest fixture: succeeds via the real htmlToText/extractTitle, no login-wall false-positive", async () => {
    const fixture = readFileSync(join(FIXTURES, "linkedin-guest.html"), "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(fixture, { status: 200, headers: { "content-type": "text/html" } })),
    );

    const result = await fetchPageText("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.text.length).toBeGreaterThanOrEqual(MIN_TEXT_CHARS);
    expect(result.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(result.pageTitle).toBeUndefined();
    expect(result.text).toContain("Software Engineer");
    expect(result.text).toContain("DHL");
  });
});
