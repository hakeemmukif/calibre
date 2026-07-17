// spec 2026-07-16-remote-startup-niche-source-expansion-design.md §4.3 step 4
// "Bulk-seed `sources` rows" + the "`sources` row after the engine" example
// (§4.3, id "gh:vercel"). Composes a validated jobhive candidate into the
// `NewSource` shape `bulkInsert` (repos/sources.ts) accepts — pure module,
// no DB.
import { describe, expect, it } from "vitest";
import { seedFromEngine } from "./seedFromEngine";
import type { JobhiveRow } from "./jobhive";
import type { ValidationOk, ValidationNotOk } from "./validate";
import { parseSourceGeo } from "../search/geo";
import { connectorForSource } from "../search/connectors";
import { createTestDb } from "../persistence/test-db";
import { createSourcesRepo } from "../persistence/repos/sources";

describe("seedFromEngine", () => {
  const row: JobhiveRow = { name: "Vercel", slug: "vercel", ats: "greenhouse", url: "https://boards.greenhouse.io/vercel" };
  const ok: ValidationOk = { ok: true, jobCount: 87, lastValidatedAt: 1_752_700_000_000 };

  it("composes a source row from (row, ok validation, provenance, companyDomain)", () => {
    const source = seedFromEngine(row, ok, ["jobhive", "yc-oss"], "vercel.com");

    expect(source).toEqual({
      id: "gh:vercel",
      name: "Vercel",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: {
        connector: "greenhouse",
        slug: "vercel",
        geo: { scope: "anywhere" },
        provenance: ["jobhive", "yc-oss"],
        companyDomain: "vercel.com",
        lastValidatedAt: 1_752_700_000_000,
        jobCount: 87,
        consecutiveFailures: 0,
        status: "active",
      },
    });
  });

  // Regression for review-blocker B3: an engine-composed row without
  // `config.geo` makes parseSourceGeo (search/geo.ts:116) fail-loud on every
  // ats source, which connectorForSource calls eagerly (search/connectors/
  // index.ts:24) OUTSIDE runFanOut's per-source try — one seeded row without
  // geo bricks the entire scan run. Spec §4.3's example row carries
  // `"geo": { "scope": "anywhere" }` explicitly.
  it("parseSourceGeo resolves (does not throw) on an engine-composed row", () => {
    const source = seedFromEngine(row, ok, ["jobhive"], "vercel.com");

    expect(() => parseSourceGeo(source as never)).not.toThrow();
    expect(parseSourceGeo(source as never)).toEqual({ scope: "anywhere" });
  });

  it("connectorForSource resolves an engine-composed row (mirrors seed.test.ts's SEA-row check)", () => {
    const source = seedFromEngine(row, ok, ["jobhive"], "vercel.com");

    const resolved = connectorForSource(source as never);
    expect(resolved.id).toBe("gh:vercel");
  });

  it("round-trips through sourcesRepo.bulkInsert with geo present", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    const source = seedFromEngine(row, ok, ["jobhive"], "vercel.com");

    const [inserted] = await repo.bulkInsert([source]);

    expect(inserted.config).toMatchObject({ geo: { scope: "anywhere" } });
  });

  it("prefixes lever and ashby ids with their connector name (not abbreviated like greenhouse)", () => {
    const leverRow: JobhiveRow = { name: "Acme", slug: "acme", ats: "lever", url: "https://jobs.lever.co/acme" };
    const ashbyRow: JobhiveRow = { name: "Beta", slug: "beta", ats: "ashby", url: "https://jobs.ashbyhq.com/beta" };

    expect(seedFromEngine(leverRow, ok, ["jobhive"], "acme.com").id).toBe("lever:acme");
    expect(seedFromEngine(ashbyRow, ok, ["jobhive"], "beta.com").id).toBe("ashby:beta");
  });

  it("fails loud on a not-ok validation instead of silently skipping", () => {
    const notOk: ValidationNotOk = { ok: false, status: 404, reason: "not_found" };

    expect(() => seedFromEngine(row, notOk, ["jobhive"], "vercel.com")).toThrow(/not-ok|404|not_found/);
  });
});
