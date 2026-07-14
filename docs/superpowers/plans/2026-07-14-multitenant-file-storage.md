# Multi-Tenant Résumé File Storage Re-root (Step 5 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Make résumé-file storage survive `local-disk-now → Contabo-VPS-later`: root from an env var (not `process.cwd()`), store per-user under a relative key, and provide a one-time migration for existing rows/files.

**Scope note (grounded in code):** `resumes.originalPath` is currently **write-only** — `ingest.ts` writes the original bytes; nothing reads/serves them (it's parse provenance). `tailored_resumes.pdfPath` is **vestigial** — the tailor PDF is rendered on-the-fly by `renderTailorPdf(id, userId)` (already Step-3-scoped) and streamed; nothing writes `pdfPath`. So this step touches ONLY the résumé-upload path. No file-serving route exists to guard yet; if one is added later it must be `requireUser`-guarded with an ownership check (noted, not built here).

**Architecture:** `CALIBER_UPLOADS_DIR` (absolute, fail-loud if unset — same posture as `DATABASE_URL`) is the storage root. Files live at `{userId}/resumes/{hash}.{ext}`; the DB stores that **relative key** (not an absolute path), so a host move is a pure `rsync` with zero DB rewriting. Per-user directories make account deletion `rm -rf {root}/{userId}` and keep content-hash dedup within a user (two users uploading the same PDF don't share one physical file).

**Tech Stack:** Next 15 · TypeScript · Node fs/promises. Builds on Step 2/3 (per-user rows, `ingest` already threads `userId`).

## Global Constraints
- **`CALIBER_UPLOADS_DIR` is required and fail-loud** — read it like `DATABASE_URL` in `db.ts` (throw a specific error if unset). No `process.cwd()` fallback (that's the `next standalone` cwd bug being fixed).
- **Store relative keys**, never absolute paths, in `resumes.originalPath`. Resolve against the root only at write time (and at read time IF a reader is ever added).
- **Per-user directory:** `{userId}/resumes/{hash}.{ext}`. `ext` = the `sourceKind` (`pdf`/`docx`); paste uploads write no file (`originalPath` stays null).
- **Fail loud.** A missing env, an unwritable dir → throw, don't silently degrade.
- **Suite stays green.** Baseline entering Step 5: 953. Tests that exercise a file upload must set `CALIBER_UPLOADS_DIR` to a temp dir (or the ingest file-write is exercised against a tmp root) — do not write into the repo.

## File Structure
- `src/server/resume/ingest.ts` — MODIFY: env-rooted, per-user relative keys.
- `src/server/resume/uploads.ts` — CREATE (optional): `uploadsRoot()` (fail-loud env read) + `resumeKey(userId, hash, ext)` + `resolveUpload(key)` helpers, so the root logic lives in one place.
- `src/server/resume/migrate-uploads.ts` — CREATE: one-time ops script (rewrite existing absolute `originalPath` rows → relative keys, move files into per-user dirs).
- `.env.example`, `config/*` if env is centralized, `.github/workflows/ci.yml` — MODIFY: add `CALIBER_UPLOADS_DIR`.
- Tests beside each.

---

## Task 1: env-rooted per-user upload keys in ingest
**Files:** `src/server/resume/uploads.ts` (+test), `src/server/resume/ingest.ts` (+ existing ingest test), `.env.example`.
- [ ] `uploads.ts`: `uploadsRoot(): string` → `const d = process.env.CALIBER_UPLOADS_DIR; if (!d) throw new Error("CALIBER_UPLOADS_DIR is not set"); return d;`. `resumeKey(userId, hash, ext): string` → `` `${userId}/resumes/${hash}.${ext}` `` (relative, forward-slashes). `resolveUpload(key): string` → `join(uploadsRoot(), key)` (for future readers).
- [ ] `ingest.ts`: replace `UPLOADS_DIR = join(process.cwd(),'data','uploads')`. For a file upload: `const key = resumeKey(userId, hash, sourceKind); const abs = resolveUpload(key); await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, bytes); originalPath = key;` — store the RELATIVE `key` in `originalPath`, not `abs`. Paste path unchanged (originalPath null).
- [ ] `.env.example`: add `# Absolute path to the résumé/upload storage root (fail-loud if unset; dev: an absolute path to a local dir; VPS: /var/lib/caliber/uploads bind-mounted).\nCALIBER_UPLOADS_DIR=/absolute/path/to/caliber-uploads`.
- [ ] Tests: `uploadsRoot()` throws when unset, returns the env when set; `resumeKey` shape; ingest with a file (set `CALIBER_UPLOADS_DIR` to a `mkdtemp` tmp dir in the test) writes to `{tmp}/{userId}/resumes/{hash}.{ext}` and stores the relative key in `originalPath`; two users uploading the same bytes get distinct per-user paths (no shared file). Paste upload stores null. Commit.

## Task 2: one-time migration script for existing rows/files
**Files:** `src/server/resume/migrate-uploads.ts` (+test).
- [ ] A CLI ops script (module-main guard, like `seed.ts`): for each `resumes` row with a non-null `originalPath` that is an ABSOLUTE path (starts with `/` — i.e. legacy), compute the new relative key `{userId}/resumes/{basename(originalPath)}`, move the file from the old absolute path to `resolveUpload(newKey)` (mkdir -p the dir; if the old file is missing, log + skip, don't throw the whole run), and update the row's `originalPath` to the relative key. Idempotent: rows already holding a relative key (no leading `/`) are skipped. Fail-loud on `CALIBER_UPLOADS_DIR` unset.
- [ ] Test (PGlite + a tmp CALIBER_UPLOADS_DIR): seed a row with an absolute `originalPath` pointing at a real tmp file → run the migration → assert the row now holds the relative key, the file exists at the new per-user location, and a re-run is a no-op. A row with a missing source file → logged, row left as-is (or flagged), no throw. Commit.

## Task 3: env wiring + green
**Files:** `.github/workflows/ci.yml` (e2e/test env block), any config env list.
- [ ] Add `CALIBER_UPLOADS_DIR` to the CI env (a tmp path, e.g. `${{ runner.temp }}/uploads` or `/tmp/caliber-uploads`) so `npm test`/e2e have it. Check `config/` for a central env schema/list and add it there if one exists (grep for `DATABASE_URL` in config).
- [ ] Ensure the vitest setup provides `CALIBER_UPLOADS_DIR` for any test that hits ingest's file path (a global test-setup default to an `os.tmpdir()` subdir, OR each such test sets it) — no test writes into the repo tree.
- [ ] Full suite green (953 + new), typecheck, `contract:check` 0 (no wire change), `npm run build`.

## Self-Review
- Env-rooted (fail-loud), per-user dirs, relative keys stored. ✓ (Task 1)
- One-time migration for legacy absolute paths, idempotent, missing-file-tolerant. ✓ (Task 2)
- Env wired for CI/tests; no repo-tree writes. ✓ (Task 3)
- **Correctly NOT touched:** `pdfPath` (vestigial — PDF rendered on-the-fly, Step-3-scoped); no file-serving route exists to guard (noted for when one is added: `requireUser` + ownership). S3 stays out of scope (this layout maps 1:1 to an S3 key scheme later).
- **Deferred:** the actual `rm -rf {root}/{userId}` account-deletion path (no account-deletion feature yet); VPS bind-mount config = Step 8 deploy artifacts.
