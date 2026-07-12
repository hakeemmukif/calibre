import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createLeverConnector } from "./lever";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "lever",
    name: "Lever",
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

describe("lever connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the postings fixture payload to RawPosting[], using hostedUrl as url", async () => {
    const fixture = [
      {
        text: "Senior Backend Engineer",
        hostedUrl: "https://jobs.lever.co/acme/abc-123",
        categories: { location: "Remote" },
        descriptionPlain: "Build things.",
        createdAt: 1717200000000,
      },
      { text: "No hostedUrl", hostedUrl: "" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const connector = createLeverConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toEqual([
      {
        sourceId: "lever",
        url: "https://jobs.lever.co/acme/abc-123",
        title: "Senior Backend Engineer",
        company: "acme",
        location: "Remote",
        description: "Build things.",
        postedAt: new Date(1717200000000).toISOString(),
      },
    ]);
  });

  it("maps confirmed geo fields: country (ISO-2) + workplaceType (capture 2026-07-12)", async () => {
    const fixture = [
      {
        text: "Executive Assistant",
        hostedUrl: "https://jobs.lever.co/acme/geo-1",
        categories: { location: "United States" },
        country: "US",
        workplaceType: "remote",
      },
      {
        text: "No geo fields",
        hostedUrl: "https://jobs.lever.co/acme/geo-2",
        categories: { location: "Remote" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const connector = createLeverConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings[0]?.geo).toEqual({ workMode: "remote", countryCode: "US" });
    expect(postings[1]?.geo).toBeUndefined();
  });

  it("yields nothing when the response body is not an array (defensive, not a hard failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "an array" }), { status: 200 })));
    const connector = createLeverConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );
    expect(postings).toEqual([]);
  });
});
