import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { createSourcesRepo } from "./sources";

describe("sourcesRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    const inserted = await repo.insert({
      id: "greenhouse",
      name: "Greenhouse",
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

    await repo.insert({ id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: {} });
    await repo.insert({ id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: {} });
    await repo.insert({ id: "everywhere", name: "Everywhere", kind: "board", persona: "both", enabled: true, config: {} });
    await repo.insert({ id: "disabled-remote", name: "Disabled Remote", kind: "ats", persona: "remote", enabled: false, config: {} });

    const remote = await repo.listEnabledByPersona("remote");
    expect(remote.map((r) => r.id).sort()).toEqual(["everywhere", "greenhouse"]);
  });

  it("listAll returns every row (disabled + both personas included) ordered by name", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.insert({ id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: {} });
    await repo.insert({ id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: false, config: {} });
    await repo.insert({ id: "everywhere", name: "Everywhere", kind: "board", persona: "both", enabled: true, config: {} });

    const all = await repo.listAll();
    expect(all.map((r) => r.name)).toEqual(["Everywhere", "Greenhouse", "JobStreet"]);
  });

  it("setEnabled flips the row and returns it", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.insert({ id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: {} });

    const updated = await repo.setEnabled("greenhouse", false);
    expect(updated?.enabled).toBe(false);

    const fetched = await repo.getById("greenhouse");
    expect(fetched?.enabled).toBe(false);
  });

  it("setEnabled on an unknown id resolves undefined", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    const updated = await repo.setEnabled("nope", true);
    expect(updated).toBeUndefined();
  });
});
