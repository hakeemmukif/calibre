import { describe, expect, it, vi } from "vitest";
import { insertJob, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { report } = await import("./eligibility-distribution");

// Regression: the query used a Postgres `count(*)::int` cast that errors on
// libsql. This asserts the grouped-count query executes on SQLite without a
// SQLITE_ERROR — an empty table and a seeded table both resolve cleanly.
describe("eligibility:report", () => {
  it("runs on an empty jobs table without a SQLITE_ERROR", async () => {
    state.testDb = await createTestDb();
    await expect(report()).resolves.toBeUndefined();
  });

  it("runs the grouped count(*) query over seeded rows without a SQLITE_ERROR", async () => {
    state.testDb = await createTestDb();
    const source = await insertSource(state.testDb, { kind: "ats" });
    await insertJob(state.testDb, source.id, { eligibility: "eligible" });
    await insertJob(state.testDb, source.id, { eligibility: "eligible" });
    await insertJob(state.testDb, source.id, { eligibility: "unknown" });
    await expect(report()).resolves.toBeUndefined();
  });
});
