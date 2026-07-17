import { describe, expect, it, vi } from "vitest";
import { createSourcesRepo } from "../persistence/repos/sources";
import { createTestDb } from "../persistence/test-db";
import { FreshnessPassError, detectAtsSignatures, runFreshnessPass } from "./freshness";

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** fetch double routed by exact URL; any un-routed URL fails the test loudly. */
function routedFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`routedFetch: unexpected url ${url}`);
    return route();
  });
}

const LEVER_ACME_ENDPOINT = "https://api.lever.co/v0/postings/acme";

function engineConfig(overrides: Record<string, unknown> = {}) {
  return {
    connector: "lever",
    slug: "acme",
    provenance: ["jobhive"],
    companyDomain: "acme.com",
    lastValidatedAt: 1_000,
    jobCount: 5,
    consecutiveFailures: 0,
    status: "active",
    ...overrides,
  };
}

async function seedEngineRow(
  repo: ReturnType<typeof createSourcesRepo>,
  configOverrides: Record<string, unknown> = {},
  rowOverrides: Record<string, unknown> = {},
) {
  return repo.insert({
    id: "lever:acme",
    name: "Acme",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: engineConfig(configOverrides),
    ...rowOverrides,
  });
}

describe("detectAtsSignatures", () => {
  it("extracts a greenhouse slug from the boards.greenhouse.io host", () => {
    expect(detectAtsSignatures('<a href="https://boards.greenhouse.io/vercel/jobs/123">Jobs</a>')).toEqual([
      { connector: "greenhouse", slug: "vercel" },
    ]);
  });

  it("extracts a greenhouse slug from the job-boards.greenhouse.io host", () => {
    expect(detectAtsSignatures('<a href="https://job-boards.greenhouse.io/vercel">Jobs</a>')).toEqual([
      { connector: "greenhouse", slug: "vercel" },
    ]);
  });

  it("extracts a lever slug", () => {
    expect(detectAtsSignatures('see https://jobs.lever.co/toptal/opening-1 for roles')).toEqual([
      { connector: "lever", slug: "toptal" },
    ]);
  });

  it("extracts an ashby slug including dots and hyphens", () => {
    expect(detectAtsSignatures('<a href="https://jobs.ashbyhq.com/my-co.io">Careers</a>')).toEqual([
      { connector: "ashby", slug: "my-co.io" },
    ]);
  });

  it("returns every distinct ATS found, greenhouse first", () => {
    const html = 'old: https://jobs.lever.co/acme new: https://boards.greenhouse.io/acme-new';
    expect(detectAtsSignatures(html)).toEqual([
      { connector: "greenhouse", slug: "acme-new" },
      { connector: "lever", slug: "acme" },
    ]);
  });

  it("returns [] for HTML with no ATS signature", () => {
    expect(detectAtsSignatures("<p>We are not hiring.</p>")).toEqual([]);
  });
});

describe("runFreshnessPass", () => {
  it("200 resets consecutiveFailures and refreshes jobCount/lastValidatedAt", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2, jobCount: 5, lastValidatedAt: 1_000 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(200, [{ id: "a" }, { id: "b" }, { id: "c" }]),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "revalidated_ok", jobCount: 3 }]);
    const row = await repo.getById("lever:acme");
    expect(row?.config).toEqual(
      engineConfig({ consecutiveFailures: 0, jobCount: 3, lastValidatedAt: 2_000 }),
    );
    expect(row?.enabled).toBe(true);
  });

  it("a not-ok validation increments consecutiveFailures, status stays active below 3", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 0 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, { error: "not found" }),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "failure_recorded", consecutiveFailures: 1 }]);
    const row = await repo.getById("lever:acme");
    expect(row?.config).toEqual(engineConfig({ consecutiveFailures: 1 }));
    expect(row?.enabled).toBe(true);
  });

  it("third consecutive 404 + ATS move on the careers page rewrites config in place (lever -> greenhouse)", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () =>
        htmlResponse(200, '<a href="https://job-boards.greenhouse.io/acme-new/jobs/1">Open roles</a>'),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([
      { id: "lever:acme", action: "redetected", connector: "greenhouse", slug: "acme-new" },
    ]);
    const row = await repo.getById("lever:acme");
    expect(row?.config).toEqual(
      engineConfig({
        connector: "greenhouse",
        slug: "acme-new",
        consecutiveFailures: 0,
        status: "active",
        // The abandoned signature is retired so it can never be re-adopted.
        redetectHistory: ["lever:acme"],
      }),
    );
    expect(row?.enabled).toBe(true);
  });

  it("re-detection falls back to the bare domain root when /careers is not a 200", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(404, "nope"),
      "https://acme.com/": () => htmlResponse(200, '<a href="https://jobs.ashbyhq.com/acme">Careers</a>'),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "redetected", connector: "ashby", slug: "acme" }]);
  });

  it("no signature on either careers URL: stays dead, disabled, and out of the enabled listing", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(200, "<p>We moved to an in-house portal.</p>"),
      "https://acme.com/": () => htmlResponse(200, "<p>Acme home</p>"),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "dead_disabled" }]);
    const row = await repo.getById("lever:acme");
    expect(row?.config).toEqual(engineConfig({ consecutiveFailures: 3, status: "dead" }));
    expect(row?.enabled).toBe(false);
    expect(await repo.listEnabledByPersona("remote")).toEqual([]);
  });

  it("a careers page still pointing at the SAME dead connector/slug is not a move — dead + disabled", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(200, '<a href="https://jobs.lever.co/acme">Jobs</a>'),
      "https://acme.com/": () => htmlResponse(200, '<a href="https://jobs.lever.co/acme">Jobs</a>'),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "dead_disabled" }]);
    const row = await repo.getById("lever:acme");
    expect(row?.enabled).toBe(false);
  });

  it("a fetch error during re-detection is a no-signal for that URL, not a crash", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === LEVER_ACME_ENDPOINT) return jsonResponse(404, {});
      throw new Error(`ENOTFOUND ${url}`);
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "dead_disabled" }]);
  });

  it("skips hand-curated rows (no provenance in config) without fetching", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await repo.insert({
      id: "gh-stripe",
      name: "Stripe",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: { connector: "greenhouse", slug: "stripe", geo: { scope: "restricted" } },
    });

    const fetchMock = vi.fn();
    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips rows already dead without fetching", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 3, status: "dead" }, { enabled: false });

    const fetchMock = vi.fn();
    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "skipped_dead" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws loudly on an engine row missing consecutiveFailures — no defaulting", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: undefined });

    await expect(runFreshnessPass({ repo, fetch: vi.fn(), now: () => 2_000 })).rejects.toThrow(
      /consecutiveFailures/,
    );
  });

  it("throws loudly on an engine row with an unknown status — no defaulting", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { status: "zombie" });

    await expect(runFreshnessPass({ repo, fetch: vi.fn(), now: () => 2_000 })).rejects.toThrow(/status/);
  });

  it("preserves unrelated config keys (e.g. geo) when rewriting health fields", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { geo: { scope: "anywhere" }, consecutiveFailures: 1 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(200, []),
    });

    await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    const row = await repo.getById("lever:acme");
    expect((row?.config as Record<string, unknown>).geo).toEqual({ scope: "anywhere" });
  });

  // B3 regression: seedFromEngine writes `geo` into every engine row's config
  // and search/run.ts reads it per scan. A re-detection rewrite that dropped
  // it would brick scans for the healed row.
  it("geo survives the re-detection config rewrite", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { geo: { scope: "anywhere" }, consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () =>
        htmlResponse(200, '<a href="https://job-boards.greenhouse.io/acme-new">Open roles</a>'),
    });

    await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    const row = await repo.getById("lever:acme");
    expect((row?.config as Record<string, unknown>).connector).toBe("greenhouse");
    expect((row?.config as Record<string, unknown>).geo).toEqual({ scope: "anywhere" });
  });

  it("geo survives the dead_disabled config rewrite", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { geo: { scope: "anywhere" }, consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(200, "<p>no ats</p>"),
      "https://acme.com/": () => htmlResponse(200, "<p>no ats</p>"),
    });

    await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    const row = await repo.getById("lever:acme");
    expect((row?.config as Record<string, unknown>).status).toBe("dead");
    expect((row?.config as Record<string, unknown>).geo).toEqual({ scope: "anywhere" });
  });
});

// S2 — a careers page carrying two stale ATS links must not ping-pong the
// row between them forever.
describe("runFreshnessPass re-detection termination", () => {
  const GH_ACME_ENDPOINT = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";
  const LEVER_OLD_ENDPOINT = "https://api.lever.co/v0/postings/old";

  // Survived two ATS migrations: a stale greenhouse footer link AND the
  // previous lever board. Neither endpoint answers.
  const TWO_STALE_LINKS =
    '<a href="https://jobs.lever.co/old">Careers</a>' +
    '<footer><a href="https://boards.greenhouse.io/acme">Jobs</a></footer>';

  function twoStaleLinksFetch() {
    return routedFetch({
      [GH_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      [LEVER_OLD_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(200, TWO_STALE_LINKS),
      "https://acme.com/": () => htmlResponse(200, TWO_STALE_LINKS),
    });
  }

  it("terminates in dead_disabled instead of ping-ponging between two stale signatures", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await repo.insert({
      id: "gh:acme",
      name: "Acme",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ connector: "greenhouse", slug: "acme", geo: { scope: "anywhere" } }),
    });

    const fetchMock = twoStaleLinksFetch();
    const actions: string[] = [];
    for (let pass = 0; pass < 12; pass += 1) {
      const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });
      actions.push(outcomes[0].action);
    }

    // Exactly one adoption (lever:old), then the row gives up — the
    // greenhouse footer link is never re-adopted.
    expect(actions.filter((a) => a === "redetected")).toHaveLength(1);
    expect(actions).toContain("dead_disabled");
    expect(actions.at(-1)).toBe("skipped_dead");

    const row = await repo.getById("gh:acme");
    expect(row?.enabled).toBe(false);
    expect((row?.config as Record<string, unknown>).status).toBe("dead");
    // Operator-visible record of what was tried and abandoned.
    expect((row?.config as Record<string, unknown>).redetectHistory).toEqual(["greenhouse:acme"]);
  });

  it("does not re-adopt a signature already recorded in redetectHistory", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await repo.insert({
      id: "lever:old",
      name: "Acme",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({
        connector: "lever",
        slug: "old",
        consecutiveFailures: 2,
        redetectHistory: ["greenhouse:acme"],
      }),
    });

    const outcomes = await runFreshnessPass({
      repo,
      fetch: twoStaleLinksFetch(),
      now: () => 2_000,
    });

    // greenhouse:acme is on the page but already tried; lever:old is current.
    expect(outcomes).toEqual([{ id: "lever:old", action: "dead_disabled" }]);
  });

  it("caps re-detections so a page serving an endless stream of new slugs still dies", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    // Every careers-page fetch advertises a brand-new lever slug, so the
    // tried-signatures history alone would never exhaust.
    let generation = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.lever.co/")) return jsonResponse(404, {});
      if (url === "https://acme.com/careers") {
        generation += 1;
        return htmlResponse(200, `<a href="https://jobs.lever.co/gen-${generation}">Careers</a>`);
      }
      if (url === "https://acme.com/") return htmlResponse(200, "<p>home</p>");
      throw new Error(`unexpected url ${url}`);
    });

    const actions: string[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });
      actions.push(outcomes[0].action);
      // Fast-forward to the death threshold so each pass can re-detect.
      const row = await repo.getById("lever:acme");
      const config = row?.config as Record<string, unknown>;
      if (config.status === "active") {
        await repo.update("lever:acme", { config: { ...config, consecutiveFailures: 2 } });
      }
    }

    expect(actions.filter((a) => a === "redetected").length).toBeLessThanOrEqual(3);
    expect(actions.at(-1)).toBe("skipped_dead");
    const row = await repo.getById("lever:acme");
    expect(row?.enabled).toBe(false);
  });
});

// S2b — a network error is absence of information, not the vendor confirming
// the board is gone. It must not kill a healthy source as fast as a 404 does,
// but a permanently unreachable host must still die.
describe("runFreshnessPass network-error policy", () => {
  function networkErrorFetch() {
    return vi.fn(async (url: string) => {
      if (url === LEVER_ACME_ENDPOINT) throw new Error(`ENOTFOUND ${url}`);
      throw new Error(`unexpected url ${url}`);
    });
  }

  it("does not kill a row at the 3-strike HTTP threshold when every failure was a network error", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const outcomes = await runFreshnessPass({ repo, fetch: networkErrorFetch(), now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "failure_recorded", consecutiveFailures: 3 }]);
    const row = await repo.getById("lever:acme");
    expect((row?.config as Record<string, unknown>).status).toBe("active");
    expect(row?.enabled).toBe(true);
  });

  it("a 200 after a network-error streak resets the row (no false-positive death)", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 5 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(200, [{ id: "a" }]),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "revalidated_ok", jobCount: 1 }]);
    expect((await repo.getById("lever:acme"))?.config).toMatchObject({ consecutiveFailures: 0 });
  });

  it("a permanently unreachable host still dies, at the higher network threshold of 6", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 5 });

    const outcomes = await runFreshnessPass({ repo, fetch: networkErrorFetch(), now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "dead_disabled" }]);
    const row = await repo.getById("lever:acme");
    expect(row?.enabled).toBe(false);
  });

  it("a confirmed HTTP not-ok kills at 3 even when earlier failures were network errors", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo, { consecutiveFailures: 2 });

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(404, {}),
      "https://acme.com/careers": () => htmlResponse(200, "<p>gone</p>"),
      "https://acme.com/": () => htmlResponse(200, "<p>gone</p>"),
    });

    const outcomes = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 });

    expect(outcomes).toEqual([{ id: "lever:acme", action: "dead_disabled" }]);
  });
});

// S3 — one corrupt config row out of ~4,000 must not discard the rest of the
// pass.
describe("runFreshnessPass malformed-row isolation", () => {
  async function seedTrio(repo: ReturnType<typeof createSourcesRepo>) {
    await repo.insert({
      id: "lever:good-a",
      name: "Good A",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ slug: "good-a" }),
    });
    await repo.insert({
      id: "lever:corrupt",
      name: "Corrupt",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ slug: "corrupt", consecutiveFailures: "three" }),
    });
    await repo.insert({
      id: "lever:good-b",
      name: "Good B",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ slug: "good-b" }),
    });
  }

  it("processes both good rows, reports the malformed one, and does not swallow the failure", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedTrio(repo);

    const fetchMock = routedFetch({
      "https://api.lever.co/v0/postings/good-a": () => jsonResponse(200, [{ id: "a" }]),
      "https://api.lever.co/v0/postings/good-b": () => jsonResponse(200, [{ id: "b" }, { id: "c" }]),
    });

    const error = await runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FreshnessPassError);
    const passError = error as FreshnessPassError;

    // The corruption is unmissable and names the row + field.
    expect(passError.message).toMatch(/lever:corrupt/);
    expect(passError.message).toMatch(/consecutiveFailures/);
    expect(passError.failures).toEqual([
      { id: "lever:corrupt", message: expect.stringMatching(/consecutiveFailures/) },
    ]);

    // Both good rows were processed AND their outcomes survived — including
    // good-b, which listAll() orders AFTER the corrupt row.
    expect(passError.outcomes).toEqual([
      { id: "lever:corrupt", action: "config_malformed", message: expect.stringMatching(/consecutiveFailures/) },
      { id: "lever:good-a", action: "revalidated_ok", jobCount: 1 },
      { id: "lever:good-b", action: "revalidated_ok", jobCount: 2 },
    ]);

    // ...and the writes landed.
    expect((await repo.getById("lever:good-a"))?.config).toMatchObject({ jobCount: 1 });
    expect((await repo.getById("lever:good-b"))?.config).toMatchObject({ jobCount: 2 });
  });

  it("a clean pass returns outcomes normally and throws nothing", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await seedEngineRow(repo);

    const fetchMock = routedFetch({
      [LEVER_ACME_ENDPOINT]: () => jsonResponse(200, []),
    });

    await expect(runFreshnessPass({ repo, fetch: fetchMock, now: () => 2_000 })).resolves.toEqual([
      { id: "lever:acme", action: "revalidated_ok", jobCount: 0 },
    ]);
  });
});
