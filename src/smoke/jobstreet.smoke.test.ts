// Real-JobStreet smoke: live-verifies the connector against the current
// `jobsearch v5` search API + `/graphql` `jobDetails` query (chalice-search
// v4 is retired upstream — see jobstreet.ts's header note). Manual-only
// (never CI, see package.json test script scoping) — a fetch/parse failure
// is a loud warning, not a red build.
import { describe, expect, it } from "vitest";
import { createJobstreetConnector } from "@/server/search/connectors/jobstreet";
import type { SourceRow } from "@/server/persistence/repos/sources";

function source(): SourceRow {
  return {
    id: "jobstreet",
    name: "JobStreet Malaysia",
    kind: "board",
    persona: "local",
    enabled: true,
    config: {
      api: "https://my.jobstreet.com/api/jobsearch/v5/search",
      siteKey: "MY-Main",
      query: "software engineer",
      pageSize: 30,
      maxPages: 1,
    },
    createdAt: new Date(),
  };
}

describe("jobstreet smoke", () => {
  it("fetches real postings, or soft-fails loudly on scraping breakage", async () => {
    const connector = createJobstreetConnector(source());

    const postings = [];
    try {
      for await (const posting of connector.discover({
        targets: [],
        since: new Date(0),
        signal: new AbortController().signal,
        onProgress: () => {},
      })) {
        postings.push(posting);
      }
    } catch (err) {
      console.warn(`[jobstreet smoke] connector failed against real API — accepted scraping-fragility risk: ${(err as Error).message}`);
      return;
    }
    expect(postings.length).toBeGreaterThanOrEqual(1);
    const [first] = postings;
    expect(first?.title).toBeTruthy();
    expect(first?.url).toMatch(/^https?:\/\//);
    console.log(`[jobstreet smoke] first item: title="${first?.title}" company="${first?.company}" location="${first?.location}"`);

    try {
      const detail = await connector.fetchDetail!(first!);
      console.log(`[jobstreet smoke] fetchDetail description (first 200 chars): ${detail.description.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[jobstreet smoke] fetchDetail failed against real GraphQL endpoint — accepted scraping-fragility risk: ${(err as Error).message}`);
    }
  });
});
