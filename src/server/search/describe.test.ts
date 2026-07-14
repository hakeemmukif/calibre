// Seam: mock only `@/server/persistence/db`'s getDb (spine.test.ts's
// pattern) so the real jobsRepo singleton runs against a pglite test db.
// connectorForSource and the real per-connector factories are left
// unmocked — a seeded jobstreet/greenhouse SourceRow resolves the real
// connector, and global `fetch` is stubbed the same way the connector test
// files stub it, so this exercises the actual describe.ts -> connectors ->
// jobsRepo wiring rather than a hand-rolled double.
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createJobsRepo } from "@/server/persistence/repos/jobs";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { ensureDescription } = await import("./describe");

describe("ensureDescription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits when the job already has a non-empty description (no connector call)", async () => {
    state.testDb = await createTestDb();
    const repo = createJobsRepo(state.testDb);
    const source = await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", config: { country: "MY" } });
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-has-description",
      url: "https://id.jobstreet.com/id/job/1",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Tech Corp",
      location: "Remote",
      persona: "local",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
      description: "Already has a JD.",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureDescription(job, source);

    expect(result).toEqual(job);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the job unchanged when the connector has no fetchDetail", async () => {
    state.testDb = await createTestDb();
    const repo = createJobsRepo(state.testDb);
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote", config: { slug: "acme", geo: { scope: "restricted" } } });
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-no-fetch-detail",
      url: "https://boards.greenhouse.io/acme/jobs/1",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    const result = await ensureDescription(job, source);

    expect(result).toEqual(job);
  });

  it("fetches detail via the connector and persists it when the description is null", async () => {
    state.testDb = await createTestDb();
    const repo = createJobsRepo(state.testDb);
    const source = await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", config: { country: "MY" } });
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-needs-detail",
      url: "https://id.jobstreet.com/id/job/2",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Tech Corp",
      location: "Kuala Lumpur",
      persona: "local",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });
    expect(job.description).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { jobDetails: { job: { content: "<p>Full JD text.</p>" } } } }), { status: 200 }),
      ),
    );

    const result = await ensureDescription(job, source);

    expect(result.id).toBe(job.id);
    expect(result.description).toBe("Full JD text.");

    const reloaded = await repo.existsById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(reloaded).toBe(true);
  });

  it("caps a fetched description at 40_000 chars before persisting", async () => {
    state.testDb = await createTestDb();
    const repo = createJobsRepo(state.testDb);
    const source = await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", config: { country: "MY" } });
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-needs-cap",
      url: "https://id.jobstreet.com/id/job/3",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Tech Corp",
      location: "Kuala Lumpur",
      persona: "local",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { jobDetails: { job: { content: `<p>${"x".repeat(50_000)}</p>` } } } }),
          { status: 200 },
        ),
      ),
    );

    const result = await ensureDescription(job, source);

    expect(result.description).toHaveLength(40_000);
  });

  it("propagates a fetch failure (caller decides tolerance)", async () => {
    state.testDb = await createTestDb();
    const repo = createJobsRepo(state.testDb);
    const source = await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", config: { country: "MY" } });
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-fetch-fails",
      url: "https://id.jobstreet.com/id/job/4",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Tech Corp",
      location: "Kuala Lumpur",
      persona: "local",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await expect(ensureDescription(job, source)).rejects.toThrow(/ECONNRESET/);
  });
});
