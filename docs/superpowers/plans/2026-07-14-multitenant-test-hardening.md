# Multi-Tenant Test Hardening (Step 7 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Close the remaining test/correctness gaps the prior steps flagged, and wire the (env-gated) e2e harness for the multi-tenant world.

**Scope note (grounded):** Most of "Step 7" from the audit is ALREADY done across Steps 1–6 — the ~20 route tests mock the session, cross-user isolation tests exist for every scoped repo/route, and a mechanical scoping-audit gate is in place. The 997-test vitest suite is the real, verified coverage. What remains: (1) the `recompute-eligibility.ts` per-owner-profile correctness fix (KNOWN-FOLLOWUP, verifiable), (2) confirm the full `npm run check` gate is green, and (3) update the env-gated Playwright e2e harness (`globalSetup.ts` + specs) so it authenticates — best-effort, since Playwright is not runnable in this environment (no browsers); flagged for a browser run to verify.

**Tech Stack:** TypeScript · Vitest · Playwright (env-gated). Builds on Steps 1–6.

## Global Constraints
- **Fail loud, per-owner correctness.** `recompute-eligibility` must resolve each job against ITS OWNER'S profile, not one global profile.
- **Do not weaken existing tests.** The 997 vitest tests + the scoping-audit gate stay green.
- **e2e is env-gated + unverifiable here.** Wire it correctly; do NOT claim it passes — mark it "requires a browser run."

---

## Task 1: recompute-eligibility per-owner profile fix
**Files:** `src/server/score/recompute-eligibility.ts` (+ a test).
Current: reads ONE profile (`profileRepo.get(BOOTSTRAP_ADMIN_ID)`) and recomputes EVERY job's eligibility against it — wrong once jobs belong to different users (a job owned by user B would be resolved against the admin's profile).
- [ ] Fetch jobs joined with their source; resolve each job's eligibility against `profileRepo.get(job.userId)` — the OWNER's profile. Cache profiles per userId within the run (a `Map<userId, ProfileRow>`) to avoid re-fetching; if a job's owner has no profile (`ProfileMissingError`), log + skip that job (don't throw the whole run — a not-yet-onboarded owner's jobs simply aren't recomputed). Remove the `BOOTSTRAP_ADMIN_ID` import if no longer used (drives a scaffold to zero). `updateEligibility(job.id, job.userId, ...)` uses the scoped write (Step 3).
- [ ] Test (PGlite): two users with DIFFERENT profiles (e.g. A relocation 'stay', B 'open') each own a job with facts that resolve differently under their own profile; run `recomputeEligibility`; assert each job got the tier computed against ITS OWNER'S profile (not cross-contaminated). A job whose owner has no profile → skipped, not thrown.
- [ ] Commit.

## Task 2: full check + e2e auth wiring (env-gated)
**Files:** `e2e/globalSetup.ts`, the e2e specs under `e2e/*.spec.ts`, `playwright.config.ts`, README/e2e note.
- [ ] **Confirm the full gate is green** (verifiable): `npm run check` (typecheck && vitest && contract:check && build) — all pass. `npm run build-storybook` succeeds. The scoping-audit gate is green. Record the numbers.
- [ ] **e2e harness auth wiring (best-effort, env-gated — cannot run here):** `globalSetup.ts` should seed the admin (env) + at least one test user, log that user in via the API (`POST /api/auth/login`), and persist a Playwright `storageState` (cookie) so the authenticated specs start signed-in. Update the specs' navigation to account for auth (they hit `/feed` etc., which now require a session + profile — the test user must be onboarded in setup). Because Playwright cannot run in this environment (no browsers), this is written but NOT executed here.
- [ ] **Document the e2e status:** add a short note (in `e2e/README.md` or the e2e-related doc) that the e2e harness now requires auth (seeded user + storageState), was updated for the multi-tenant migration, and must be verified with a browser run (`npx playwright install --with-deps chromium && npm run test:e2e`). Do NOT mark e2e as passing.
- [ ] Commit.

## Self-Review
- `recompute-eligibility` resolves per-owner profile, caches per user, skips profile-less owners, uses the scoped write. ✓ (Task 1) — closes the KNOWN-FOLLOWUP.
- Full `npm run check` + storybook + audit gate green (verified). ✓ (Task 2)
- e2e harness wired for auth (env-gated, documented as needing a browser run, NOT claimed passing). ✓ (Task 2)
- **Already covered by Steps 1–6 (not re-done):** session mocks in route tests, cross-user isolation tests, the mechanical scoping-audit gate. **Deferred honestly:** the actual Playwright browser run (env-gated).
