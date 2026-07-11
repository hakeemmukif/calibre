import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createGreenhouseConnector } from "./greenhouse";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "greenhouse",
    name: "Greenhouse",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("greenhouse connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the boards-api fixture payload to RawPosting[], using absolute_url as url", async () => {
    const fixture = {
      jobs: [
        {
          id: 123,
          title: "Senior Backend Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
          location: { name: "Remote" },
          first_published: "2026-06-01T00:00:00Z",
        },
        { id: 456, title: "No URL Job", absolute_url: "" }, // dropped — no absolute_url
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createGreenhouseConnector(source());
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "greenhouse",
        externalId: "123",
        url: "https://boards.greenhouse.io/acme/jobs/123",
        title: "Senior Backend Engineer",
        company: "acme",
        location: "Remote",
        postedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createGreenhouseConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({
          targets: [],
          since: new Date(0),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response as a thrown error (caught by run.ts, not swallowed here)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createGreenhouseConnector(source());
    await expect(
      collect(
        connector.discover({
          targets: [],
          since: new Date(0),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
