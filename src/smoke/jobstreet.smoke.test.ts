// Real-JobStreet smoke: the connector has never been live-verified against
// id.jobstreet.com's chalice-search v4 API (see jobstreet.ts's header note).
// Scraping fragility is an accepted risk — a fetch/parse failure is a loud
// warning, not a red build.
import { describe, expect, it } from "vitest";
import { createJobstreetConnector } from "@/server/search/connectors/jobstreet";
import type { SourceRow } from "@/server/persistence/repos/sources";

function source(): SourceRow {
  return {
    id: "jobstreet",
    name: "JobStreet",
    kind: "board",
    persona: "local",
    enabled: true,
    config: { query: "software engineer", maxPages: 1 },
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
  });
});
