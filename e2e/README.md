# e2e (Playwright) — auth-ready, NOT run in this environment

Updated for the multi-tenant migration (Step 7 Task 2). **This harness has
not been executed here** — this sandbox has no browsers installed and
Playwright cannot launch Chromium. Everything below was wired and
typechecked but needs a real run (`npx playwright install --with-deps
chromium && npm run test:e2e`) on a machine with browser support before it
can be trusted. Do not treat this document as a passing report.

## Why auth wiring was needed

Post-migration, every route under `src/app/(app)/` (feed, resume, jobs,
tracker, sources, profile, admin) redirects a session-less request to
`/login`, and a session with no `profile` row to `/onboarding`
(`src/app/(app)/layout.tsx`). Every existing spec does a bare `page.goto`
or `request.post` against these routes with no login step, so without auth
wiring the whole suite would now redirect to `/login` and fail.

## What changed

- **`e2e/authSetup.ts`** (new) — wired as Playwright's native `globalSetup`
  config option (distinct from `e2e/globalSetup.ts`, which stays wired via
  the `pretest:e2e` npm hook and only does DB provisioning). Per the
  ordering documented at the bottom of `e2e/globalSetup.ts`
  (`WebServerPlugin.setup()` runs before `config.globalSetups`), by the
  time `authSetup.ts` runs, `next dev` is already up and healthy, so it can
  make real HTTP requests. It:
  1. `POST /api/auth/register` a fixed test user
     (`e2e-user@caliber.test`), falling back to `POST /api/auth/login` on a
     409 (already-registered) — robust if the scratch DB ever stops being
     dropped/recreated per run.
  2. `PUT /api/profile` to onboard that user (`baseCountry: "MY",
     relocation: "stay"`) — required, since `(app)/layout.tsx` redirects a
     profile-less session to `/onboarding` instead of rendering `/feed`.
  3. Saves the authenticated `APIRequestContext`'s cookies via
     `context.storageState({ path: "e2e/.auth/user.json" })`.
- **`playwright.config.ts`**:
  - `globalSetup: "./e2e/authSetup.ts"`.
  - `use.storageState: "./e2e/.auth/user.json"` — applies to both the
    `page` and `request` fixtures Playwright Test hands to every spec, so
    no per-spec changes were needed for the common case.
  - `webServer.env` gained `SESSION_COOKIE_SECURE: "false"` — **load-
    bearing, not cosmetic**: without it, `sessionCookieOptions()`
    (`src/server/auth/session.ts`) sets `Secure` on the session cookie by
    default, which browsers refuse to send back over the suite's plain
    `http://localhost:3005` baseURL. Session cookies minted during
    `authSetup.ts` would round-trip into `storageState.json` but silently
    never be sent by the browser, and every spec would still redirect to
    `/login`. This was previously unset in `playwright.config.ts`.
  - `webServer.env` also gained `ADMIN_EMAIL`/`ADMIN_PASSWORD` defaults, per
    the task brief. These are currently **unused** by the e2e DB path —
    `db:seed:test` (`e2e/globalSetup.ts` → `npm run db:seed:test` →
    `seed-test.ts`) never creates a `users` row; only `npm run db:seed`
    (`seed.ts`, not used by e2e) reads these vars to upsert the bootstrap
    admin. They're reserved here for a future admin-flow spec that switches
    to `db:seed`, or CI parity.
- **`.gitignore`**: added `e2e/.auth/` — the storage state file contains a
  live session cookie and must not be committed.

## Known gap found while wiring this — NOT fixed (out of bounded scope)

**`sources.spec.ts`** toggles a source's enabled flag through the UI, which
calls `PATCH /api/sources/:id`. That route now calls `requireAdmin()`
(`src/app/api/sources/[id]/route.ts`), but `POST /api/auth/register` always
creates a `role: "user"` account, never `admin`
(`src/app/api/auth/register/route.ts`'s own comment: "Role is always
literal 'user'; never admin"). The single shared test user this harness
authenticates as is therefore a non-admin, so **`sources.spec.ts`'s toggle
assertion is expected to fail with a 403** under the current wiring — the
UI will presumably not flip to "Disabled" and the `expect(toggle
).toHaveText("Disabled")` assertion will fail.

This needs one of, decided by whoever runs the suite next:
- a second `storageState` (e.g. an admin-authenticated project/context) used
  only by `sources.spec.ts`, or
- changing what `sources.spec.ts` asserts (no longer in scope here — this
  task was bounded to harness/config, not spec bodies), or
- seeding/promoting the shared e2e user to `admin` some other way.

Not fixed here because it's a spec-body-level decision, not harness wiring,
and the task scope explicitly excluded blind spec rewrites.

## Specs that need per-spec browser verification

All 8 specs need a real browser run to confirm the storageState wiring
actually gets them signed-in and past onboarding — none of this could be
exercised in this environment. Specific things to watch for:

| Spec | Needs before it can render | Notes |
|---|---|---|
| `feed.spec.ts` | profile only | Simplest case — good first spec to run to confirm the storageState pattern works at all. |
| `sources.spec.ts` | profile only | **Expected to fail** — see "Known gap" above (admin-only PATCH). |
| `resume-scan-feed.spec.ts` | profile only (it creates its own résumé via the UI) | Also has a pre-existing route-warmup workaround for `next dev` on-demand compilation (see its own comment) — unrelated to auth, unaffected by this change, but still worth re-confirming end-to-end. |
| `profile.spec.ts` | profile + résumé (bootstraps its own résumé via `POST /api/resume`) | Exercises `/profile` (relocation flip) — same auth path as everything else, should be fine given `profileRepo.upsert` is used both by onboarding and by this route. |
| `detail-evaluate-applied.spec.ts` | profile + résumé + a scored job (bootstraps both via API helpers) | No admin routes touched. |
| `tailor.spec.ts` | profile + résumé + a scored job | Also spawns a real headless Chromium for PDF generation internally (per its own name/comment) — unrelated to auth but another reason a browser is required to verify it. |
| `pasted-job.spec.ts` | profile only | No admin routes touched. |

Every spec (including the ones above) shares **one** authenticated test
user across the whole run (`workers: 1`, one `storageState.json`) — this
mirrors the pre-existing assumption already documented in these specs'
comments ("DB shared across specs within one invocation"; a single active
résumé row; a single per-persona run lock), now made explicit as "one e2e
user" rather than an implicit single-tenant install.

`sources` table rows are global/unscoped by design
(`src/app/api/sources/route.ts`'s comment: "sources DATA itself stays
global/unscoped"), so `seed-test.ts`'s fixture sources are visible to the
e2e test user regardless of who's logged in — no per-user seeding gap
there. `profile`/`resumes`/`jobs` are per-user, so the seeded admin
`profile` row (`id: "default"`, owned by `BOOTSTRAP_ADMIN_ID`) that
`seed-test.ts` inserts is **not** the e2e test user's profile — the e2e
user gets its own row via `authSetup.ts`'s `PUT /api/profile`, which is
correct and expected.

## How to actually verify this

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

This was not run here. A green run of at least `feed.spec.ts` in isolation
(`npx playwright test e2e/feed.spec.ts`) is the minimum bar to confirm the
storageState/auth wiring itself works before trusting the rest of the
suite.
