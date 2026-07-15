import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { resumes, users } from "@/server/persistence/schema";
import { resolveUpload } from "./uploads";
import { migrateUploads } from "./migrate-uploads";

const structuredFixture = {
  storeVersion: 2 as const,
  extractionPath: "text" as const,
  name: "Jane Doe",
  contact: [],
  summary: "s",
  experience: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

async function insertResume(db: TestDb, userId: string, originalPath: string | null) {
  const [row] = await db
    .insert(resumes)
    .values({
      userId,
      rawText: "raw text",
      structured: structuredFixture,
      originalPath,
      sourceKind: "pdf",
      isActive: true,
    })
    .returning();
  return row;
}

describe("migrateUploads", () => {
  let uploadsDir: string;
  let legacyDir: string;
  const originalEnv = process.env.CALIBER_UPLOADS_DIR;

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), "caliber-uploads-migrate-"));
    legacyDir = await mkdtemp(join(tmpdir(), "caliber-legacy-uploads-"));
    process.env.CALIBER_UPLOADS_DIR = uploadsDir;
  });

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true });
    await rm(legacyDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.CALIBER_UPLOADS_DIR;
    else process.env.CALIBER_UPLOADS_DIR = originalEnv;
  });

  it("(a) moves a legacy absolute-path row's file into the per-user relative key and rewrites originalPath", async () => {
    const db = await createTestDb();
    const oldAbsPath = join(legacyDir, "abc123.pdf");
    await writeFile(oldAbsPath, "legacy pdf bytes");

    const row = await insertResume(db, BOOTSTRAP_ADMIN_ID, oldAbsPath);

    const result = await migrateUploads(db);
    expect(result).toEqual({ migrated: 1, skippedMissing: 0 });

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.originalPath).toBe(`${BOOTSTRAP_ADMIN_ID}/resumes/abc123.pdf`);
    expect(existsSync(oldAbsPath)).toBe(false);
    expect(await readFile(resolveUpload(after.originalPath!), "utf-8")).toBe("legacy pdf bytes");
  });

  it("(b) re-running after a successful migration is a no-op", async () => {
    const db = await createTestDb();
    const oldAbsPath = join(legacyDir, "def456.pdf");
    await writeFile(oldAbsPath, "legacy pdf bytes 2");
    const row = await insertResume(db, BOOTSTRAP_ADMIN_ID, oldAbsPath);

    await migrateUploads(db);
    const [migratedRow] = await db.select().from(resumes).where(eq(resumes.id, row.id));

    const result = await migrateUploads(db);
    expect(result).toEqual({ migrated: 0, skippedMissing: 0 });

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.originalPath).toBe(migratedRow.originalPath);
  });

  it("(c) a row whose source file is missing is logged and left as-is, without throwing", async () => {
    const db = await createTestDb();
    const missingAbsPath = join(legacyDir, "ghost789.pdf");
    // never write the file at missingAbsPath
    const row = await insertResume(db, BOOTSTRAP_ADMIN_ID, missingAbsPath);

    const result = await migrateUploads(db);
    expect(result).toEqual({ migrated: 0, skippedMissing: 1 });

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.originalPath).toBe(missingAbsPath);
  });

  it("(d) a row already holding a relative key is untouched", async () => {
    const db = await createTestDb();
    const relativeKey = `${BOOTSTRAP_ADMIN_ID}/resumes/already-migrated.pdf`;
    const row = await insertResume(db, BOOTSTRAP_ADMIN_ID, relativeKey);

    const result = await migrateUploads(db);
    expect(result).toEqual({ migrated: 0, skippedMissing: 0 });

    const [after] = await db.select().from(resumes).where(eq(resumes.id, row.id));
    expect(after.originalPath).toBe(relativeKey);
  });

  it("migrates two users' legacy rows into distinct per-user keys", async () => {
    const db = await createTestDb();
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-migrate@example.com", passwordHash: "h", role: "user" })
      .returning();

    const oldAbsPathA = join(legacyDir, "shared-hash.pdf");
    const oldAbsPathB = join(legacyDir, "userb", "shared-hash.pdf");
    await writeFile(oldAbsPathA, "user a bytes");
    await mkdir(dirname(oldAbsPathB), { recursive: true });
    await writeFile(oldAbsPathB, "user b bytes");

    const rowA = await insertResume(db, BOOTSTRAP_ADMIN_ID, oldAbsPathA);
    const rowB = await insertResume(db, userB.id, oldAbsPathB);

    const result = await migrateUploads(db);
    expect(result).toEqual({ migrated: 2, skippedMissing: 0 });

    const [afterA] = await db.select().from(resumes).where(eq(resumes.id, rowA.id));
    const [afterB] = await db.select().from(resumes).where(eq(resumes.id, rowB.id));

    expect(afterA.originalPath).toBe(`${BOOTSTRAP_ADMIN_ID}/resumes/shared-hash.pdf`);
    expect(afterB.originalPath).toBe(`${userB.id}/resumes/shared-hash.pdf`);
    expect(afterA.originalPath).not.toBe(afterB.originalPath);
    expect(await readFile(resolveUpload(afterA.originalPath!), "utf-8")).toBe("user a bytes");
    expect(await readFile(resolveUpload(afterB.originalPath!), "utf-8")).toBe("user b bytes");
  });
});
