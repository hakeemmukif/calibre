import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createSmartRecruitersConnector } from "./smartrecruiters";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "smartrecruiters",
    name: "SmartRecruiters",
    kind: "ats",
    persona: "local",
    enabled: true,
    config: { slug: "Grab" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function response(content: unknown[]): Response {
  return new Response(JSON.stringify({ offset: 0, limit: 100, totalFound: content.length, content }), { status: 200 });
}

describe("smartrecruiters connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the postings fixture payload to RawPosting[], deriving url from slug+id+slugified name", async () => {
    // Payload shape curled 2026-07-21 from
    // `api.smartrecruiters.com/v1/companies/Grab/postings`.
    const fixture = [
      {
        id: "744000138772750",
        name: "Senior Sales Operations Analyst",
        releasedDate: "2026-07-21T02:36:14.429Z",
        location: {
          city: "Pasig City",
          country: "ph",
          remote: false,
          hybrid: false,
          fullLocation: "Pasig City, , Philippines",
        },
        department: {},
        function: { id: "other", label: "Other" },
        ref: "https://api.smartrecruiters.com/v1/companies/Grab/postings/744000138772750",
      },
      { id: "", name: "No id" }, // dropped — no id
    ];
    const fetchMock = vi.fn().mockResolvedValue(response(fixture));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createSmartRecruitersConnector(source());
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "smartrecruiters",
        externalId: "744000138772750",
        url: "https://jobs.smartrecruiters.com/Grab/744000138772750-senior-sales-operations-analyst",
        title: "Senior Sales Operations Analyst",
        company: "Grab",
        location: "Pasig City, Philippines",
        department: "Other",
        geo: { countryCode: "PH" },
        postedAt: "2026-07-21T02:36:14.429Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.smartrecruiters.com/v1/companies/Grab/postings?limit=100&offset=0&status=PUBLIC",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("prefers department.label over function.label when both are present (P.4 tag input)", async () => {
    const fixture = [
      { id: "1", name: "Eng", department: { label: "Engineering" }, function: { label: "Other" } },
      { id: "2", name: "No department field", function: { label: "Sales" } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(fixture)));
    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(postings[0].department).toBe("Engineering");
    expect(postings[1].department).toBe("Sales"); // function is the honest fallback
  });

  it("maps confirmed geo fields: remote/hybrid -> workMode, country -> countryCode (live-verified 2026-07-21)", async () => {
    const fixture = [
      {
        id: "1",
        name: "Remote role",
        location: { city: "Petaling Jaya", country: "my", remote: true, hybrid: false, fullLocation: "Petaling Jaya, , Malaysia" },
      },
      {
        id: "2",
        name: "Hybrid role",
        location: { city: "Singapore", country: "sg", remote: false, hybrid: true, fullLocation: "Singapore, , Singapore" },
      },
      { id: "3", name: "No location field" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(fixture)));
    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(postings[0]?.geo).toEqual({ workMode: "remote", countryCode: "MY" });
    expect(postings[0]?.location).toBe("Petaling Jaya, Malaysia, Remote");
    expect(postings[1]?.geo).toEqual({ workMode: "hybrid", countryCode: "SG" });
    expect(postings[2]?.geo).toBeUndefined();
  });

  it("paginates: follows a full page with another fetch, stops on a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, name: `Job ${i}` }));
    const page2 = [{ id: "p2-0", name: "Last job" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(page1))
      .mockResolvedValueOnce(response(page2));
    vi.stubGlobal("fetch", fetchMock);

    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=0");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=100");
    expect(postings).toHaveLength(101);
  });

  it("stops pagination when a page returns an empty content array", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, name: `Job ${i}` }));
    const fetchMock = vi.fn().mockResolvedValueOnce(response(page1)).mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetchMock);

    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postings).toHaveLength(100);
  });

  it("yields nothing when content is missing or not an array (defensive, not a hard failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ totalFound: 0 }), { status: 200 })));
    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );
    expect(postings).toEqual([]);
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createSmartRecruitersConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response on the first page as a thrown error (caught by run.ts, not swallowed here)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createSmartRecruitersConnector(source());
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("degrades gracefully on a later-page failure — keeps postings already yielded", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, name: `Job ${i}` }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(page1))
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const postings = await collect(
      createSmartRecruitersConnector(source()).discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    );

    expect(postings).toHaveLength(100);
  });
});
