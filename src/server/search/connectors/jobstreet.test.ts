import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting } from "../connector";
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

// Representative shape of a jobsearch v5 `data[]` item — trimmed from a live
// `GET my.jobstreet.com/api/jobsearch/v5/search` response captured 2026-07-12
// (chalice-search v4 is retired upstream; see jobstreet.ts's header note).
function fixturePage(items: unknown[]) {
  return new Response(JSON.stringify({ data: items, totalCount: items.length }), { status: 200 });
}

describe("jobstreet connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a fixture jobsearch v5 page to RawPosting[], constructing the job URL from id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fixturePage([
        {
          id: "93132187",
          title: "Graduate Software Engineer ",
          companyName: "SEEK",
          advertiser: { id: "adv1", description: "SEEK" },
          branding: { serpLogoUrl: "https://bcassets.example/logo.png" },
          locations: [{ label: "Kuala Lumpur", countryCode: "MY" }],
          jobUrl: null,
          listingDate: "2026-07-01T00:00:00Z",
        },
        { title: "No ID Job" }, // dropped — no id
        { id: "999" }, // dropped — no title
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
        url: "https://my.jobstreet.com/job/93132187",
        title: "Graduate Software Engineer",
        company: "SEEK",
        location: "Kuala Lumpur",
        postedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("falls back to advertiser.description when companyName is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fixturePage([
        {
          id: "1",
          title: "Backend Engineer",
          advertiser: { description: "Acme Sdn Bhd" },
          locations: [{ label: "Petaling Jaya" }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connector = createJobstreetConnector(source());
    const [posting] = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(posting?.company).toBe("Acme Sdn Bhd");
  });

  it("stops paginating once a page returns fewer than pageSize results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fixturePage(Array.from({ length: 2 }, (_, i) => ({ id: `${i}`, title: `Job ${i}` }))));
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
      .mockResolvedValueOnce(fixturePage(Array.from({ length: 2 }, (_, i) => ({ id: `${i}`, title: `Job ${i}` }))))
      .mockRejectedValueOnce(new Error("page 2 timed out"));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createJobstreetConnector(source({ config: { query: "x", pageSize: 2, maxPages: 3 } }));
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toHaveLength(2);
  });

  describe("fetchDetail", () => {
    function posting(overrides: Partial<RawPosting> = {}): RawPosting {
      return {
        sourceId: "jobstreet",
        url: "https://my.jobstreet.com/job/93132187",
        title: "Graduate Software Engineer",
        company: "SEEK",
        ...overrides,
      };
    }

    function graphqlResponse(content: string) {
      return new Response(
        JSON.stringify({ data: { jobDetails: { job: { id: "93132187", title: "Graduate Software Engineer", content } } } }),
        { status: 200 },
      );
    }

    it("posts the GraphQL jobDetails query and extracts text via htmlToText", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(graphqlResponse("<strong>Company Description</strong>\n\n<p>Join our team.</p>"));
      vi.stubGlobal("fetch", fetchMock);

      const connector = createJobstreetConnector(source());
      const detail = await connector.fetchDetail!(posting());

      expect(detail).toEqual({ description: "Company Description Join our team." });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://my.jobstreet.com/graphql",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "content-type": "application/json", "user-agent": expect.any(String) }),
          body: expect.stringContaining('"id":"93132187"'),
        }),
      );
    });

    it("caps the extracted description at 40_000 chars", async () => {
      const html = `<p>${"x".repeat(50_000)}</p>`;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphqlResponse(html)));

      const connector = createJobstreetConnector(source());
      const detail = await connector.fetchDetail!(posting());

      expect(detail.description).toHaveLength(40_000);
    });

    it("throws when the posting url has no /job/{id} segment (fail loud, not a silent skip)", async () => {
      const connector = createJobstreetConnector(source());
      await expect(
        connector.fetchDetail!(posting({ url: "https://my.jobstreet.com/companies/seek" })),
      ).rejects.toThrow(/could not extract job id/);
    });

    it("throws when GraphQL content is empty (fail loud, not a silent empty description)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphqlResponse("")));

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
