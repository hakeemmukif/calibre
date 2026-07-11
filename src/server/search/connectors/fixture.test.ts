import { describe, expect, it } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createFixtureConnector } from "./fixture";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "greenhouse",
    name: "Greenhouse",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: {},
    createdAt: new Date(),
    ...overrides,
  };
}

describe("fixture connector", () => {
  it("yields a deterministic RawPosting for a known source id", async () => {
    const conn = createFixtureConnector(source());
    const postings = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) {
      postings.push(p);
    }
    expect(postings).toHaveLength(1);
    expect(postings[0].sourceId).toBe("greenhouse");
    expect(postings[0].title).toContain("Backend Engineer");
  });

  it("yields nothing for an unknown source id", async () => {
    const conn = createFixtureConnector(source({ id: "unknown", kind: "board", persona: "local", name: "x" }));
    const postings = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) postings.push(p);
    expect(postings).toHaveLength(0);
  });
});
