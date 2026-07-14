// One-time ops script (CLI, module-main guard mirrors seed.ts): legacy
// `resumes.originalPath` rows hold an ABSOLUTE path (pre-Step-5 ingest wrote
// `join(process.cwd(), 'data', 'uploads', hash.ext)`). Rewrites each such row
// to the per-user relative key (uploads.ts's resumeKey shape) and moves the
// physical file into the per-user directory under CALIBER_UPLOADS_DIR.
// Idempotent — rows already holding a relative key (no leading `/`) are
// skipped — and missing-file-tolerant: a row whose source file is gone is
// logged and left untouched (so a re-run can pick it up if the file
// reappears), never throwing the whole run for one bad row.
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../persistence/repos/db";
import { resumes } from "../persistence/schema";
import { getDb } from "../persistence/db";
import { resolveUpload, resumeKey } from "./uploads";

export interface MigrateUploadsResult {
  migrated: number;
  skippedMissing: number;
}

export async function migrateUploads(db: Db): Promise<MigrateUploadsResult> {
  const rows = await db.select().from(resumes).where(isNotNull(resumes.originalPath));

  let migrated = 0;
  let skippedMissing = 0;

  for (const row of rows) {
    const oldPath = row.originalPath;
    if (!oldPath || !oldPath.startsWith("/")) continue; // null or already a relative key: no-op

    const base = basename(oldPath);
    const lastDot = base.lastIndexOf(".");
    if (lastDot <= 0) {
      console.warn(`migrate-uploads: row ${row.id} — cannot parse "{hash}.{ext}" from basename "${base}", skipping`);
      continue;
    }
    const hash = base.slice(0, lastDot);
    const ext = base.slice(lastDot + 1);
    const newKey = resumeKey(row.userId, hash, ext);
    const newAbs = resolveUpload(newKey);

    try {
      await mkdir(dirname(newAbs), { recursive: true });
      await rename(oldPath, newAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`migrate-uploads: row ${row.id} — source file missing at "${oldPath}", skipping (left as-is)`);
        skippedMissing++;
        continue;
      }
      throw err;
    }

    await db.update(resumes).set({ originalPath: newKey }).where(eq(resumes.id, row.id));
    migrated++;
  }

  return { migrated, skippedMissing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  migrateUploads(db)
    .then(({ migrated, skippedMissing }) => {
      console.log(`migrate-uploads: migrated ${migrated} row(s), skipped ${skippedMissing} missing-file row(s)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
