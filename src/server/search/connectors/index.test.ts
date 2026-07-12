import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { connectorForSource } from "./index";

function source(id: string, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id,
    name: id,
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme", geo: { scope: "restricted" } },
    createdAt: new Date(),
    ...overrides,
  };
}

describe("connectorForSource", () => {
  it.each(["greenhouse", "lever", "ashby", "jobstreet"])("resolves a connector for %s keyed by source.id", (id) => {
    const connector = connectorForSource(source(id));
    expect(connector.id).toBe(id);
  });

  it("throws for an unregistered source id", () => {
    expect(() => connectorForSource(source("workday"))).toThrow(/workday/);
  });

  it("resolves the connector from config.connector when present (per-company rows)", () => {
    const connector = connectorForSource(
      source("gh-gitlab", { name: "GitLab", config: { connector: "greenhouse", slug: "gitlab", geo: { scope: "anywhere" } } }),
    );
    expect(connector.id).toBe("gh-gitlab");
  });

  it("still throws fail-loud for an unknown connector key", () => {
    expect(() => connectorForSource(source("mystery", { config: { geo: { scope: "restricted" } } }))).toThrow(
      /No connector registered/,
    );
  });

  it("throws fail-loud for a real-mode source missing its geo annotation (spec §9.2)", () => {
    expect(() => connectorForSource(source("greenhouse", { config: { slug: "acme" } }))).toThrow(
      /needs config.geo.scope/,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fixture connector when CALIBER_TEST_DOUBLES=1", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const { connectorForSource } = await import("./index");
    const conn = connectorForSource({ id: "greenhouse", kind: "ats", persona: "remote", enabled: true, config: {}, name: "x" } as never);
    const out = [];
    for await (const p of conn.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} })) out.push(p);
    expect(out[0]?.sourceId).toBe("greenhouse");
  });
});
