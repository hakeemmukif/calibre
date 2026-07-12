import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertSource } from "./__fixtures__/helpers";
import { createUrlChecksRepo } from "./urlChecks";

describe("urlChecksRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);

    const inserted = await repo.insert({
      url: "https://boards.greenhouse.io/example/jobs/123",
      dedupeKey: "greenhouse.io/example/jobs/123",
      status: "queued",
      alreadyKnown: false,
      needsText: false,
      costUsd: 0,
      raw: { pastedText: null },
    });
    expect(inserted.status).toBe("queued");
    expect(inserted.jobId).toBeNull();
    expect(inserted.finishedAt).toBeNull();

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
