// Storage-root helpers for résumé uploads. CALIBER_UPLOADS_DIR is read
// fail-loud (mirrors DATABASE_URL in persistence/db.ts) — no process.cwd()
// fallback, since that breaks under `next standalone`'s cwd. Keys stored in
// the DB are always the RELATIVE per-user key, never an absolute path, so a
// host move (local disk -> VPS) is a pure file rsync with no DB rewrite.
import { join } from "node:path";

export function uploadsRoot(): string {
  const d = process.env.CALIBER_UPLOADS_DIR;
  if (!d) throw new Error("CALIBER_UPLOADS_DIR is not set");
  return d;
}

export function resumeKey(userId: string, hash: string, ext: string): string {
  return `${userId}/resumes/${hash}.${ext}`;
}

export function resolveUpload(key: string): string {
  return join(uploadsRoot(), key);
}
