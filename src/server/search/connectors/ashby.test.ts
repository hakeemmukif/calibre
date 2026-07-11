import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createAshbyConnector } from "./ashby";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "ashby",
    name: "Ashby",
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

describe("ashby connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("maps the posting-api fixture payload to RawPosting[], using jobUrl as url", async () => {
    const fixture = {
      jobs: [
        {
          title: "Senior Backend Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/abc-123",
          location: "Remote",
          publishedAt: "2026-06-01T00:00:00.000Z",
        },
        { title: "No jobUrl" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const connector = createAshbyConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toEqual([
      {
        sourceId: "ashby",
        url: "https://jobs.ashbyhq.com/acme/abc-123",
        title: "Senior Backend Engineer",
        company: "acme",
        location: "Remote",
        postedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
  });

  it("retries on failure and throws the last error once retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));

    const connector = createAshbyConnector(source());
    const iterator = connector.discover({
      targets: [],
      since: new Date(0),
      signal: new AbortController().signal,
      onProgress: () => {},
    })[Symbol.asyncIterator]();

    const assertion = expect(iterator.next()).rejects.toThrow(/HTTP 429/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
