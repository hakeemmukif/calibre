import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createJobstreetConnector } from "./jobstreet";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "jobstreet",
    name: "JobStreet",
    kind: "board",
    persona: "local",
    enabled: true,
    config: { query: "backend engineer" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// Representative shape of a chalice-search v4 `data[]` item (career-ops/
// providers/jobstreet.mjs docblock) — not captured from a live request.
function fixturePage(items: unknown[]) {
  return new Response(JSON.stringify({ data: items }), { status: 200 });
}

describe("jobstreet connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a fixture chalice-search page to RawPosting[], resolving relative jobUrl against the API host", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fixturePage([
        {
          title: "Backend Engineer",
          jobUrl: "/id/job/123456",
          branding: { companyName: "Tech Corp" },
          location: "Jakarta Selatan",
          listingDate: "2026-06-15T00:00:00Z",
        },
        { title: "No URL Job" }, // dropped — no jobUrl
        { jobUrl: "/id/job/999" }, // dropped — no title
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connector = createJobstreetConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toEqual([
      {
        sourceId: "jobstreet",
        url: "https://id.jobstreet.com/id/job/123456",
        title: "Backend Engineer",
        company: "Tech Corp",
        location: "Jakarta Selatan",
        postedAt: "2026-06-15T00:00:00Z",
      },
    ]);
  });

  it("stops paginating once a page returns fewer than pageSize results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fixturePage(Array.from({ length: 2 }, (_, i) => ({ title: `Job ${i}`, jobUrl: `/id/job/${i}` }))));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createJobstreetConnector(source({ config: { query: "x", pageSize: 30, maxPages: 3 } }));
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 2 < pageSize(30) → stop after page 1
  });

  it("degrades gracefully: a page-1 throw/timeout propagates so run.ts can catch it into stats.perSource, without crashing the process", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const connector = createJobstreetConnector(source());

    await expect(
      collect(
        connector.discover({
          targets: [],
          since: new Date(0),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("degrades gracefully on a later-page failure: returns postings already collected instead of throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fixturePage(Array.from({ length: 2 }, (_, i) => ({ title: `Job ${i}`, jobUrl: `/id/job/${i}` }))),
      )
      .mockRejectedValueOnce(new Error("page 2 timed out"));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createJobstreetConnector(source({ config: { query: "x", pageSize: 2, maxPages: 3 } }));
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toHaveLength(2);
  });

  describe("fetchDetail", () => {
    function posting(overrides: Partial<import("../connector").RawPosting> = {}): import("../connector").RawPosting {
      return {
        sourceId: "jobstreet",
        url: "https://id.jobstreet.com/id/job/123456",
        title: "Backend Engineer",
        company: "Tech Corp",
        ...overrides,
      };
    }

    it("fetches the SSR job page and extracts text via htmlToText", async () => {
      const html = "<html><body><h1>Backend Engineer</h1><p>Join our team.</p></body></html>";
      const fetchMock = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const connector = createJobstreetConnector(source());
      const detail = await connector.fetchDetail!(posting());

      expect(detail).toEqual({ description: "Backend Engineer Join our team." });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://id.jobstreet.com/id/job/123456",
        expect.objectContaining({ headers: expect.objectContaining({ "user-agent": expect.any(String) }) }),
      );
    });

    it("caps the extracted description at 40_000 chars", async () => {
      const html = `<p>${"x".repeat(50_000)}</p>`;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, { status: 200 })));

      const connector = createJobstreetConnector(source());
      const detail = await connector.fetchDetail!(posting());

      expect(detail.description).toHaveLength(40_000);
    });

    it("throws when the detail page yields no text (fail loud, not a silent empty description)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<script>track()</script>", { status: 200 })));

      const connector = createJobstreetConnector(source());
      await expect(connector.fetchDetail!(posting())).rejects.toThrow(/yielded no text/);
    });

    it("propagates a non-2xx response as a thrown error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

      const connector = createJobstreetConnector(source());
      await expect(connector.fetchDetail!(posting())).rejects.toThrow(/HTTP 404/);
    });
  });
});
