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

  it("update rewrites config and enabled together and returns the row", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.insert({ id: "lever:acme", name: "Acme", kind: "ats", persona: "remote", enabled: true, config: { slug: "acme" } });

    const updated = await repo.update("lever:acme", { config: { slug: "acme-new", status: "dead" }, enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.config).toEqual({ slug: "acme-new", status: "dead" });

    const fetched = await repo.getById("lever:acme");
    expect(fetched?.enabled).toBe(false);
    expect(fetched?.config).toEqual({ slug: "acme-new", status: "dead" });
  });

  it("update on an unknown id resolves undefined", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    const updated = await repo.update("nope", { config: {} });
    expect(updated).toBeUndefined();
  });
});

describe("sourcesRepo.bulkInsert", () => {
  it("round-trips the config shape (insert then read back, deep-equal)", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    const config = {
      connector: "greenhouse",
      slug: "vercel",
      provenance: ["jobhive", "yc-oss"],
      companyDomain: "vercel.com",
      lastValidatedAt: 1_752_700_000_000,
      jobCount: 87,
      consecutiveFailures: 0,
      status: "active",
    };

    const [inserted] = await repo.bulkInsert([
      { id: "gh:vercel", name: "Vercel", kind: "ats", persona: "remote", enabled: true, config },
    ]);

    expect(inserted.config).toEqual(config);

    const fetched = await repo.getById("gh:vercel");
    expect(fetched?.config).toEqual(config);
  });

  it("conflict on an existing id is a no-op (second insert of same id ignored, first row unchanged)", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.bulkInsert([
      { id: "gh:vercel", name: "Vercel", kind: "ats", persona: "remote", enabled: true, config: { jobCount: 1 } },
    ]);
    await repo.bulkInsert([
      { id: "gh:vercel", name: "Vercel (stale)", kind: "ats", persona: "remote", enabled: false, config: { jobCount: 999 } },
    ]);

    const fetched = await repo.getById("gh:vercel");
    expect(fetched?.name).toBe("Vercel");
    expect(fetched?.enabled).toBe(true);
    expect(fetched?.config).toEqual({ jobCount: 1 });
  });

  it("listEnabledByPersona returns the bulk-seeded rows", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);

    await repo.bulkInsert([
      { id: "gh:vercel", name: "Vercel", kind: "ats", persona: "remote", enabled: true, config: {} },
      { id: "lever:acme", name: "Acme", kind: "ats", persona: "remote", enabled: true, config: {} },
    ]);

    const remote = await repo.listEnabledByPersona("remote");
    expect(remote.map((r) => r.id).sort()).toEqual(["gh:vercel", "lever:acme"]);
  });
});
