// Global vitest default so any test touching ingest's file-write branch
// (CALIBER_UPLOADS_DIR is fail-loud, no process.cwd() fallback — see
// src/server/resume/uploads.ts) has a writable root without writing into
// the repo tree. Tests that need a specific tmp dir per-case (e.g.
// src/app/api/resume/route.test.ts, src/server/resume/migrate-uploads.test.ts)
// still set/restore their own mkdtemp value around this default.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultUploadsDir = join(tmpdir(), "caliber-test-uploads");
mkdirSync(defaultUploadsDir, { recursive: true });
process.env.CALIBER_UPLOADS_DIR ??= defaultUploadsDir;
