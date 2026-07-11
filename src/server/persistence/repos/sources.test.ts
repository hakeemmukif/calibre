import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { createSourcesRepo } from "./sources";

describe("sourcesRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    const inserted = await repo.insert({
      id: "greenhouse",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: { slug: "acme" },
    });

    expect(inserted.id).toBe("greenhouse");
    const fetched = await repo.getById("greenhouse");
    expect(fetched?.kind).toBe("ats");
  });

  it("listEnabledByPersona matches the exact persona and 'both'", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.insert({ id: "greenhouse", kind: "ats", persona: "remote", enabled: true, config: {} });
    await repo.insert({ id: "jobstreet", kind: "board", persona: "local", enabled: true, config: {} });
    await repo.insert({ id: "everywhere", kind: "board", persona: "both", enabled: true, config: {} });
    await repo.insert({ id: "disabled-remote", kind: "ats", persona: "remote", enabled: false, config: {} });

    const remote = await repo.listEnabledByPersona("remote");
    expect(remote.map((r) => r.id).sort()).toEqual(["everywhere", "greenhouse"]);
  });
});
