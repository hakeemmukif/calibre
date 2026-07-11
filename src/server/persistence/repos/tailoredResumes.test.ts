import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createTailoredResumesRepo } from "./tailoredResumes";

describe("tailoredResumesRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [{ section: "summary", op: "modify", before: "old", after: "new", reason: "tighter framing" }],
      status: "queued",
    });

    expect(inserted.status).toBe("queued");
    expect(inserted.finalizedAt).toBeNull();

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.diff[0].section).toBe("summary");
  });
});
