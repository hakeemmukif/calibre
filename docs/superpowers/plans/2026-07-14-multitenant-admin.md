# Multi-Tenant Admin Routes + Page (Step 6 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** The admin surface. A `requireAdmin()`-guarded users list (with per-user counts), full content access to any user's data (operator-locked decision #7), the sources-toggle behind admin, and an `/admin` page.

**Architecture:** Admin is additive — `requireAdmin()` (`requireUser` + role check → 403 FORBIDDEN) guards a new `/api/admin/*` namespace. **Decision #7 (operator-locked, against the list-only recommendation — do NOT re-litigate): admin has FULL content access** to users' résumés/jobs/applications. Implement it by admin routes passing the **target** userId into the SAME Step-3 scoped repos — so no unscoped query is ever added and the scoping-audit gate stays green. The admin page composes the existing `Tracker/TrackerTable` Card-table treatment. UI CANON applies (compose primitives, mirror compositions, Storybook, never invent).

**Tech Stack:** Next 15 · TypeScript · Zod · Drizzle · caliber-ui. Builds on Step 1 (`requireAdmin`), 3 (scoped repos, `GLOBAL-BY-DECISION` audit gate), 4 (shell + role-gated Admin nav item → `/admin`).

## Global Constraints
- **`requireAdmin()` on every `/api/admin/*` route + the sources mutation** → 403 `FORBIDDEN` for a non-admin, 401 `UNAUTHORIZED` for no session. Register both in the contract.
- **Decision #7 content access via target userId into scoped repos.** Admin content routes call the SAME `jobsRepo`/`resumesRepo`/`applicationsRepo` methods with the target user's id — never a new unscoped query. The scoping-audit gate must stay green (no method loses its `userId` param).
- **Never expose `passwordHash`.** `AdminUser` wire schema excludes it (`.parse()` strips it).
- **Privacy note (recorded, not re-litigated):** full admin access to career/salary data is the operator's explicit choice. Every admin content route is a `requireAdmin` route; no impersonation, no session-swap — the admin reads via the target id.
- **Suite stays green.** Baseline entering Step 6: 963. UI canon for the page.

---

## Task 1: admin users list API + sources-toggle behind admin
**Files:** `src/types/index.ts` (add `AdminUser` + `AdminUsersResponse`); `src/server/persistence/repos/users.ts` (add a counts read); `src/app/api/admin/users/route.ts` (new, `GET`); `src/app/api/sources/[id]/route.ts` (PATCH → requireAdmin); `src/contract/registry.ts`; tests.
- [ ] `AdminUser` Zod: `{ id, email, role: 'user'|'admin', createdAt: datetime, resumeCount: int, jobCount: int, applicationCount: int }` (never the hash). `AdminUsersResponse = { items: AdminUser[] }`. Type exports.
- [ ] `usersRepo.listWithCounts(): Promise<AdminUserRow[]>` — list all users LEFT JOIN per-user counts of `resumes`/`jobs`/`applications` (group by user_id; JS-merge is fine at MVP scale, or a single grouped query). This is an admin-global read → carries a `// GLOBAL-BY-DECISION: admin lists every account with counts` comment (keeps the audit gate green). Do NOT add `userId` scoping (it's the admin cross-user list by design).
- [ ] `GET /api/admin/users`: `requireAdmin()` → `usersRepo.listWithCounts()` → `AdminUsersResponse.parse({items})` → 200; `UnauthorizedError`→401, `ForbiddenError`→403.
- [ ] `PATCH /api/sources/[id]`: change `requireUser()` → `requireAdmin()` (fulfilling the existing TODO); map `ForbiddenError`→403. (Sources data stays global; only admins toggle connectors.)
- [ ] Register both in the contract (`/api/admin/users` GET 200/401/403; `/api/sources/{id}` PATCH now 403-capable). `contract:check` green.
- [ ] Tests: `listWithCounts` returns correct per-user counts (seed 2 users with differing résumé/job/application rows); `GET /api/admin/users` 200 for admin, 403 for a normal user, 401 for no session, and NEVER includes `passwordHash`; `PATCH /api/sources/:id` 403 for a normal user, 200 for admin. Commit.

## Task 2: admin content-access routes (decision #7)
**Files:** `src/app/api/admin/users/[id]/resume/route.ts`, `.../jobs/route.ts`, `.../applications/route.ts` (new, `GET`); `src/contract/registry.ts`; tests.
- [ ] Each `GET /api/admin/users/[id]/{resume|jobs|applications}`: `requireAdmin()` → validate `[id]` is a uuid (404 if not) → call the SAME scoped repo method with the TARGET id: `resumesRepo.getActive(targetId)` / `listJobsFeed(query, targetId)` / `applicationsRepo.list(targetId)` → return the same wire shapes the user-facing routes return. A nonexistent target → the scoped read returns empty/null → 404/empty (same as a user with no data). NO new unscoped query — reuse the scoped methods with the admin-supplied target id.
- [ ] Register the 3 routes in the contract (200/401/403/404). `contract:check` green.
- [ ] Tests: an admin can fetch user B's résumé/jobs/applications via `/api/admin/users/{B}/…` (seed B's data, assert the admin sees it); a NORMAL user gets 403 on these routes; no session → 401; the returned shapes match the user-facing wire schemas; the scoping-audit gate still passes (no repo method lost its userId param). Commit.

## Task 3: /admin page + Storybook
**Files:** `src/app/(app)/admin/page.tsx` (new — under `(app)` so it gets the shell + session/profile guard; admins are normal users who also onboarded); `src/features/admin/client.ts` (fetch wrapper); a composition `src/caliber-ui/compositions/Admin/AdminUsersTable.tsx` (+ stories) mirroring `Tracker/TrackerTable`; tests.
- [ ] `features/admin/client.ts`: `getAdminUsers(): Promise<AdminUser[]>` → GET `/api/admin/users` (parse `AdminUsersResponse`). Mirror `profile/client.ts`.
- [ ] `AdminUsersTable` composition: a `Card`-wrapped table of users (email, role, createdAt, résumé/job/application counts) mirroring `TrackerTable`'s treatment — compose existing primitives only. Storybook stories: a few users, an admin among them, empty state.
- [ ] `admin/page.tsx` (`"use client"`): load `getAdminUsers()`, render `AdminUsersTable` with busy/error (mirror `sources/page.tsx`/`tracker` page pattern). A non-admin who somehow reaches `/admin` — the API 403s → show a "not authorized" state (the nav item is already role-gated in Step 4, so this is defense-in-depth).
- [ ] Tests: the page renders the users table from a mocked client; the Admin nav item (Step 4) routes here (already wired). Component test for `AdminUsersTable`.

## Task 4: green + live admin smoke
- [ ] Full suite green (963 + new), typecheck, `contract:check` 0, `npm run build`, Storybook builds, and the **scoping-audit gate still passes** (Task 1/2 added an admin-global read with a GLOBAL-BY-DECISION comment; confirm the gate is green).
- [ ] Live smoke (throwaway DB + server): seed the admin (env) + register a normal user B with some data; as admin → `GET /api/admin/users` returns both accounts with counts (no passwordHash); as admin → `GET /api/admin/users/{B}/jobs` returns B's jobs; as B (normal) → `GET /api/admin/users` → 403 and `PATCH /api/sources/{id}` → 403; unauthenticated → 401. Drop the DB.

## Self-Review
- `requireAdmin` guards `/api/admin/*` + sources PATCH (403/401 registered). ✓ (Tasks 1, 2)
- Users list + per-user counts, no passwordHash. ✓ (Task 1)
- Decision #7 full content access via target userId into the SAME scoped repos (no new unscoped query; audit gate green). ✓ (Task 2, 4)
- `/admin` page composes existing primitives/TrackerTable treatment + stories. ✓ (Task 3)
- Live-verified admin-vs-normal (200/403). ✓ (Task 4)
- **Privacy stance recorded, not re-litigated** (decision #7). **Deferred:** role-management UI (promote via seed/SQL until it hurts); user impersonation (never — admin reads via target id). `recompute-eligibility.ts` per-owner-profile follow-up could be addressed here or Step 7.
