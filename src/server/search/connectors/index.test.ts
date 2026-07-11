import { describe, expect, it } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { connectorForSource } from "./index";

function source(id: string, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id,
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
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
});
