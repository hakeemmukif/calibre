// Real-libsql smoke: repo tests run against an in-memory libsql client
// (src/server/persistence/test-db.ts) which the real `@libsql/client` driver
// (src/server/persistence/db.ts) never exercises. This is the only place that does.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDb } from "@/server/persistence/db";
import { sources } from "@/server/persistence/schema";

describe("sqlite smoke", () => {
  it("migrates and round-trips a sources row through the real libsql driver", async () => {
    const db = getDb();
    await migrate(db, { migrationsFolder: "./drizzle" });

    const id = `smoke-${Date.now()}`;
    try {
      await db.insert(sources).values({ id, name: "Smoke Source", kind: "board", persona: "both", enabled: true, config: {} });
      const [row] = await db.select().from(sources).where(eq(sources.id, id));
      expect(row?.name).toBe("Smoke Source");
    } finally {
      await db.delete(sources).where(eq(sources.id, id));
    }
  });
});
