# Multi-Tenant Frontend: Route Groups + AppShell + Onboarding (Step 4 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Session-aware UI. Login/register render chrome-free; the app shell shows the real signed-in user with a logout affordance and a conditional Admin nav group; a profile-less registrant is routed to onboarding instead of 500ing at the feed.

**Architecture:** Next route groups — `(auth)` (chrome-free login/register) and `(app)` (the 8 existing pages under a server layout that enforces the session and renders `AppShell`). `getSession()` (server) resolves the user in the `(app)` layout and root `page.tsx`; the client `AppShell` receives the user as a prop. **UI canon (non-negotiable):** compose the existing `src/caliber-ui/components` primitives + `styles/tokens.css` tokens, mirror the existing `compositions/*` patterns, add Storybook stories — never invent components or inline bespoke CSS beyond token usage.

**Tech Stack:** Next 15 App Router · React 19 · TypeScript · `src/caliber-ui` design system · Vitest + @testing-library/react · Storybook. Builds on Step 1 (`getSession`, auth routes) + Step 3 (`PUT /api/profile` upsert, all routes `requireUser`-guarded).

## Global Constraints
- **Compose primitives; never invent components.** New compositions live under `src/caliber-ui/compositions/<Area>/` with a `.stories.tsx`, styled only via tokens (`var(--...)`), mirroring existing compositions.
- **`getSession()` is server-only.** The `(app)` server layout + root `page.tsx` call it; the client `AppShell` and pages receive the user via prop or the `GET /api/auth/session` client wrapper. Never import `next/headers` into a client component.
- **Fail loud, no fake user.** No placeholder "Alex Tan". If the `(app)` layout has no session → `redirect('/login')`. Onboarding is the ONLY authenticated-but-profile-less destination.
- **Do not change API behavior.** This step is UI + routing only; the auth/profile/logout endpoints already exist.
- **Suite stays green.** Baseline 919. Add component tests + stories.

## File moves (route groups)
Current: `src/app/{feed,jobs,profile,resume,sources,tracker}/…` + `src/app/AppShell.tsx` + `src/app/layout.tsx` (wraps AppShell) + `src/app/page.tsx` (redirect /feed).
Target: `src/app/(app)/{feed,jobs,profile,resume,sources,tracker,onboarding}/…` + `src/app/(app)/layout.tsx` (session guard + AppShell) + `src/app/(auth)/{login,register}/…` + `src/app/(auth)/layout.tsx` (chrome-free) + `src/app/layout.tsx` (root `<html><body>` + tokens only) + `src/app/page.tsx` (session-aware). Route groups don't change URLs (`/feed` stays `/feed`).

---

## Task 1: route-group restructure + session-aware root
**Files:** move the 6 page dirs under `src/app/(app)/`; `src/app/(app)/layout.tsx` (new), `src/app/(auth)/layout.tsx` (new), `src/app/layout.tsx` (slim to html/body/tokens), `src/app/page.tsx` (rewrite), `src/app/AppShell.tsx` (accept `user` prop — full wiring in Task 4). Update the API-route tests / `spine.test.ts` for any import-path shifts (AppShell import path is unchanged; page dirs move).
- [ ] Root `layout.tsx`: keep `import '@/caliber-ui/styles/tokens.css'` + `<html><body>{children}</body></html>` — REMOVE the global `<AppShell>` wrap (it moves to `(app)/layout.tsx`).
- [ ] `(app)/layout.tsx` (server component): `const user = await getSession(); if (!user) redirect('/login'); return <AppShell user={user}>{children}</AppShell>`. Import `getSession` from `@/server/auth/session`, `redirect` from `next/navigation`.
- [ ] `(auth)/layout.tsx`: minimal centered chrome-free wrapper (a token-styled `<main>`; no sidebar). Compose with tokens.
- [ ] `page.tsx` (server): `const user = await getSession(); if (!user) redirect('/login'); ` then check profile — call the profile repo/`getSession`-cached path: `try { await profileRepo.get(user.id); redirect('/feed') } catch (ProfileMissingError) { redirect('/onboarding') }`. (Import `profileRepo` + `ProfileMissingError`; this is a server component so direct repo use is fine.)
- [ ] Move the 6 page dirs under `(app)/`. Verify `npm run build` maps routes unchanged (`/feed`, `/jobs/[id]`, etc.).
- [ ] Test: root `/` redirects to `/login` (no session), `/onboarding` (session, no profile), `/feed` (session + profile) — mock `getSession`/`profileRepo`. Commit.

## Task 2: login + register pages + client wrappers
**Files:** `src/app/(auth)/login/page.tsx`, `register/page.tsx`; a new composition `src/caliber-ui/compositions/Auth/AuthCard.tsx` (+ `.stories.tsx`) composing `Card`/`Input`/`Button`; `src/features/auth/client.ts` (fetch wrappers). Mirror `src/features/profile/client.ts` for the client-fetch shape and `src/app/(app)/profile/page.tsx` for the busy/error page pattern.
- [ ] `features/auth/client.ts`: `register({email,password})` → POST `/api/auth/register`; `login({email,password})` → POST `/api/auth/login`; `logout()` → POST `/api/auth/logout`. Parse `SessionResponse`/`ErrorEnvelope`; throw on non-2xx with the envelope message.
- [ ] `AuthCard` composition: a `Card` with email `Input`, password `Input` (type=password), submit `Button`, an error line (token-styled), and a link to the other mode. Storybook stories: default, error, busy.
- [ ] `login/page.tsx` (client): AuthCard(mode=login) → on submit `login()` → success `router.push('/')` (root re-routes to onboarding/feed) → error shows message. `register/page.tsx`: same with `register()`. Link between them.
- [ ] Tests: submit success calls the client + redirects; 401/409 shows the error message; validation (short password) surfaces. Commit.

## Task 3: onboarding page + profile-404 routing
**Files:** `src/app/(app)/onboarding/page.tsx`; reuse the `Profile/ProfileTargets` composition (or a slim onboarding variant) — do NOT invent; compose existing. Ensure `(app)/layout.tsx` does NOT redirect-loop (it only enforces session, not profile — onboarding is reachable with a session and no profile).
- [ ] `onboarding/page.tsx` (client): a minimal profile form (baseCountry + relocation, the two `Profile` fields) composing existing primitives/`ProfileTargets`; on save → `updateProfile`/`PUT /api/profile` (the Step-3 upsert creates the row) → `router.push('/feed')`.
- [ ] Confirm the app pages that read the profile (feed/etc.) degrade gracefully for a profile-less session: since the (app) layout allows profile-less sessions in (so onboarding renders), the feed page must handle its own profile-404 by `router.push('/onboarding')` rather than showing a 500/error. Add that redirect to the feed page's error handling (a 404/ProfileMissing from `GET /api/jobs` → onboarding).
- [ ] Tests: onboarding save creates the profile + redirects to feed; feed page routes a profile-404 to onboarding. Commit.

## Task 4: AppShell — real user + logout + conditional Admin nav + store reset
**Files:** `src/app/AppShell.tsx`, `src/caliber-ui/compositions/Shell/*` if a ProfileChip/account composition is extracted (+ stories), the checksStore reset wiring (`src/features/url-check/checksStore.ts` `__resetChecksStore`).
- [ ] `AppShell({ user, children })`: replace the hardcoded "Alex Tan" ProfileChip with `user.email` (and role as the sub-label) via `Avatar name={user.email}`. Add a **logout affordance** (an `IconButton`/`Button` in the footer near ProfileChip): on click → `logout()` client wrapper → `__resetChecksStore()` → `router.push('/login')`.
- [ ] **Conditional Admin nav group:** when `user.role === 'admin'`, append an "Admin" section + a "Users" item (`id:'admin-users'`, route `/admin`) to the sidebar `ITEMS`/`ENABLED`/`routeFor`/`activeIdFor`. (The `/admin` page itself is Step 6 — the nav item routes there; a Step-6 page will exist. For now the item can route to `/admin` which 404s until Step 6, OR guard adding it until Step 6 — prefer adding the nav wiring now behind the role check and let Step 6 add the page.)
- [ ] Wire `__resetChecksStore` to fire on logout and on a user-id change (so a re-login as a different user starts clean).
- [ ] Storybook: AppShell/ProfileChip stories for a normal user and an admin user (showing the Admin group). Update any existing story hardcoding "Alex Tan".
- [ ] Tests: ProfileChip renders the user's email; logout calls logout()+reset+redirect; Admin group shows only for role admin. Commit.

## Task 5: full green + live redirect smoke
- [ ] `npm test` green (919 + new), `npm run typecheck`, `npm run build` (routes map unchanged), Storybook builds (`npm run build-storybook`), `contract:check` 0 (no API change — confirm).
- [ ] Live smoke (throwaway DB + server, follow redirects with curl `-L`/`-i`): unauthenticated GET `/` → 307 → `/login`; register via the form's endpoint → then GET `/` with the cookie → `/onboarding` (no profile) → PUT profile → GET `/` → `/feed`; logout → GET `/` → `/login`. Assert the redirect chain. (UI rendering is covered by component tests + Storybook; this smoke validates the server-side session→route wiring end-to-end.) Drop the DB.

## Self-Review
- `(auth)`/`(app)` route groups; auth pages chrome-free; app pages under a session-guarding server layout. ✓ (Task 1)
- Session-aware root: login → onboarding-if-no-profile → feed. ✓ (Task 1, 3)
- Login/register compose primitives + stories. ✓ (Task 2)
- Onboarding unblocks fresh registrants (no 500). ✓ (Task 3)
- AppShell real user + logout + store reset + conditional Admin nav; "Alex Tan" gone. ✓ (Task 4)
- **Deferred:** the `/admin` PAGE + `GET /api/admin/users` = Step 6 (this step only adds the role-gated nav item). Full Playwright browser E2E = Step 7 (env-gated). Résumé file re-root = Step 5.
