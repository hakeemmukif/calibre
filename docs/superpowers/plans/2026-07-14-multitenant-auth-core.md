# Multi-Tenant Auth Core Implementation Plan (Step 1 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hand-rolled email+password auth — `users` + `sessions` tables, argon2id hashing, opaque hashed-token cookie sessions, and `getSession()`/`requireUser()`/`requireAdmin()` guards — as the foundation every later tenancy step builds on. No data is sliced per-user yet; this step only introduces identity.

**Architecture:** Row-level identity in the existing single Postgres DB. Passwords hashed with argon2id (`@node-rs/argon2`). Session token = 32 random bytes (base64url) sent in an httpOnly SameSite=Lax cookie; only its SHA-256 hash is stored, so a DB dump never yields live sessions. Enforcement is a per-request `getSession()` (wrapped in React `cache()`) called at the top of route handlers — **never** Next middleware (CVE-2025-29927 bypass precedent; the edge runtime can't use postgres.js anyway). Contract-first: Zod wire schemas in `src/types`, routes registered in `src/contract/registry.ts`. Admin is a `role` column, not a separate table; the first admin is seeded from env against a fixed well-known UUID so Step 2's backfill migration can target it.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript · Zod (contract in `src/types/index.ts`) · Drizzle + Postgres (PGlite in-memory for tests) · Vitest · `@node-rs/argon2` (new).

## Global Constraints

- **`src/types/index.ts` is the single source of truth.** Any wire-shape change is mirrored in `docs/architecture/api-contract.md` and re-generated: `npm run contract:check` regenerates `contract/openapi.json` and `git diff --exit-code`s it — the build fails until the regenerated file is committed.
- **Fail loud. No fallbacks.** Missing required value → throw a specific error. Never default to `0`/`""`/`"unknown"`/anonymous. `requireUser()` throws; it never returns a null/guest user.
- **Never authenticate in Next middleware.** Guards run inside route handlers / server components only.
- **Store only the SHA-256 hash of a session token.** The raw token exists only in the cookie and in the response that mints it.
- **Email is normalized to lowercase at the boundary** (repo input), stored in a `text` column with a `unique` constraint — no `citext` (keep PGlite-replayable).
- **Migrations must be no-op-safe on an empty PGlite DB.** `test-db.ts` replays every `drizzle/*.sql` into a fresh empty PGlite on every repo test; a migration that assumes existing rows breaks the whole suite.
- **The fixed bootstrap admin UUID is a shared constant** (`BOOTSTRAP_ADMIN_ID`), referenced by `seed.ts` now and by Step 2's backfill migration DML later. Define it in one place and import it.
- **Repo pattern:** `createXRepo(db: Db)` factory returning an object of async methods, plus an exported singleton bound to `getDb()`. `Db` = `PgDatabase<any, typeof schema>` from `src/server/persistence/repos/db.ts`.
- **Route error envelope:** every handler maps domain errors to `ErrorEnvelope` via a local `errorResponse(status, code, message, details?)` helper (mirror `src/app/api/profile/route.ts`).

---

## File Structure

- `src/server/persistence/schema.ts` — MODIFY: add `users` + `sessions` tables (append after `applications`).
- `drizzle/0008_*.sql` + `drizzle/meta/*` — CREATE via `drizzle-kit generate` (users + sessions DDL).
- `src/server/auth/password.ts` — CREATE: argon2id `hashPassword` / `verifyPassword`.
- `src/server/auth/token.ts` — CREATE: `mintSessionToken()` (raw + hash), `hashToken(raw)`.
- `src/server/auth/ids.ts` — CREATE: `BOOTSTRAP_ADMIN_ID` constant.
- `src/server/auth/errors.ts` — CREATE: `UnauthorizedError`, `ForbiddenError`, `EmailTakenError`, `InvalidCredentialsError`.
- `src/server/persistence/repos/users.ts` — CREATE: users repo.
- `src/server/persistence/repos/sessions.ts` — CREATE: sessions repo.
- `src/server/auth/session.ts` — CREATE: `getSession()` (React `cache`), `requireUser()`, `requireAdmin()`, cookie name/helpers.
- `src/app/api/auth/register/route.ts` — CREATE: `POST`.
- `src/app/api/auth/login/route.ts` — CREATE: `POST`.
- `src/app/api/auth/logout/route.ts` — CREATE: `POST`.
- `src/app/api/auth/session/route.ts` — CREATE: `GET`.
- `src/types/index.ts` — MODIFY: add `UNAUTHORIZED`/`FORBIDDEN` to `ErrorCode`; add `AuthUser`, `RegisterRequest`, `LoginRequest`, `SessionResponse`.
- `src/contract/registry.ts` — MODIFY: register the 4 auth paths + new entities.
- `src/contract/generate.ts` — MODIFY: flip the `AUTH_NOTE` string.
- `src/server/persistence/seed.ts` — MODIFY: bootstrap admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- `.env.example` — MODIFY: add `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_COOKIE_SECURE`.
- `docs/architecture/api-contract.md` — MODIFY: auth section + remove "every route unauthenticated" line (docs-are-canon).

Test files sit beside each unit (`*.test.ts`), mirroring the repo convention.

---

## Task 1: Add the argon2 dependency

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Install**

```bash
cd "$(git rev-parse --show-toplevel)"   # worktree root
npm install @node-rs/argon2@^2.0.0
```

- [ ] **Step 2: Verify it loads in the Node test runtime**

```bash
node -e "const a=require('@node-rs/argon2'); console.log(typeof a.hash, typeof a.verify)"
```
Expected: `function function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(auth): add @node-rs/argon2 for password hashing"
```

---

## Task 2: users + sessions schema and migration

**Files:**
- Modify: `src/server/persistence/schema.ts`
- Create: `drizzle/0008_*.sql` (generated), `drizzle/meta/0008_snapshot.json` + `_journal.json` (generated)
- Test: `src/server/persistence/repos/users.test.ts` (baseline table-exists check; fuller tests in Task 5)

**Interfaces:**
- Produces: `users` table (`id uuid pk`, `email text unique`, `passwordHash text`, `role text enum('user','admin')`, `createdAt timestamptz`), `sessions` table (`id uuid pk`, `userId uuid fk→users.id`, `tokenHash text unique`, `createdAt timestamptz`, `lastUsedAt timestamptz`). Drizzle inferred types `typeof users.$inferSelect` etc.

- [ ] **Step 1: Add the tables to `schema.ts`** (append after the `applications` table, mirror existing column idioms)

```ts
// Multi-tenant identity (spec: 2026-07-14 auth core). Passwords argon2id;
// sessions store only the SHA-256 hash of an opaque token. role gates the
// admin surface — no separate admins table (additive capability only).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // normalized lowercase at the repo boundary
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["user", "admin"] }).notNull(), // written explicitly at insert — no column default (no-fallback)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the opaque cookie token
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note: new tables use `timestamptz` (`withTimezone: true`) — the correct default going forward. Existing tables' TZ-naive columns are converted in Step 2's migration, not here.

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate
```
Expected: a new `drizzle/0008_*.sql` creating `users` and `sessions`, plus updated `drizzle/meta/`. Inspect the SQL: it must be plain `CREATE TABLE` (no destructive statements).

- [ ] **Step 3: Verify the migration replays on empty PGlite**

Write `src/server/persistence/repos/users.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";

describe("users schema", () => {
  it("migration creates an insertable users table on an empty PGlite DB", async () => {
    const db = await createTestDb();
    const [row] = await db
      .insert(users)
      .values({ email: "a@b.co", passwordHash: "x", role: "user" })
      .returning();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.role).toBe("user");
  });
});
```

- [ ] **Step 4: Run it**

Run: `npm test -- src/server/persistence/repos/users.test.ts`
Expected: PASS (proves the generated SQL replays cleanly on a fresh PGlite).

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/schema.ts drizzle/ src/server/persistence/repos/users.test.ts
git commit -m "feat(auth): users + sessions tables + migration"
```

---

## Task 3: password hashing module

**Files:**
- Create: `src/server/auth/password.ts`
- Test: `src/server/auth/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).not.toContain("correct horse"); // not plaintext
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("produces distinct hashes for the same input (random salt)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- src/server/auth/password.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// argon2id password hashing. Defaults from @node-rs/argon2 (Argon2id,
// memoryCost/timeCost tuned for interactive login). The hash string is
// self-describing (algorithm + params + salt embedded), so verify needs
// only the stored hash + the candidate.
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain); // @node-rs/argon2 defaults to argon2id
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false; // malformed hash → not a match (never throw into the auth path)
  }
}
```

- [ ] **Step 4: Run to verify it passes** — expect PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): argon2id password hashing"`

---

## Task 4: session token module + shared ids

**Files:**
- Create: `src/server/auth/token.ts`, `src/server/auth/ids.ts`
- Test: `src/server/auth/token.test.ts`

**Interfaces:**
- Produces: `mintSessionToken(): { raw: string; hash: string }`, `hashToken(raw: string): string`. `BOOTSTRAP_ADMIN_ID: string` (fixed UUID).

- [ ] **Step 1: Create `ids.ts`**

```ts
// Fixed well-known UUID for the bootstrap admin. seed.ts inserts/updates this
// row from ADMIN_EMAIL/ADMIN_PASSWORD; Step 2's user_id backfill migration
// assigns all pre-existing single-user rows to this id. Never regenerate it.
export const BOOTSTRAP_ADMIN_ID = "00000000-0000-4000-8000-000000000001";
```

- [ ] **Step 2: Write the failing test for `token.ts`**

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintSessionToken, hashToken } from "./token";

describe("session tokens", () => {
  it("mints a raw token whose stored hash is its SHA-256 (hex)", () => {
    const { raw, hash } = mintSessionToken();
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(hash).not.toBe(raw); // raw never equals what we store
  });

  it("hashToken is deterministic and matches mint", () => {
    const { raw, hash } = mintSessionToken();
    expect(hashToken(raw)).toBe(hash);
  });

  it("successive mints differ", () => {
    expect(mintSessionToken().raw).not.toBe(mintSessionToken().raw);
  });
});
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement `token.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function mintSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
```

- [ ] **Step 5: Run to verify it passes.**

- [ ] **Step 6: Commit** — `git commit -m "feat(auth): opaque session tokens + bootstrap admin id"`

---

## Task 5: users repo

**Files:**
- Create: `src/server/persistence/repos/users.ts`
- Test: extend `src/server/persistence/repos/users.test.ts`

**Interfaces:**
- Consumes: `Db`, `users` table, `hashPassword`/`verifyPassword` (Task 3).
- Produces: `createUserRepo(db)` → `{ create({email, passwordHash, role}), findByEmail(email), findById(id), list() }`. `UserRow = typeof users.$inferSelect`. Exported singleton `usersRepo`. `EmailTakenError` (from `auth/errors.ts`, Task 8 — create the errors file here if reached first).

- [ ] **Step 1: Write failing tests** (append to `users.test.ts`)

```ts
import { createUserRepo } from "./users";
import { EmailTakenError } from "@/server/auth/errors";

describe("usersRepo", () => {
  it("create() normalizes email to lowercase and findByEmail is case-insensitive", async () => {
    const repo = createUserRepo(await createTestDb());
    const u = await repo.create({ email: "Alex@Example.COM", passwordHash: "h", role: "user" });
    expect(u.email).toBe("alex@example.com");
    expect((await repo.findByEmail("alex@EXAMPLE.com"))?.id).toBe(u.id);
  });

  it("create() throws EmailTakenError on duplicate (normalized) email", async () => {
    const repo = createUserRepo(await createTestDb());
    await repo.create({ email: "dup@x.co", passwordHash: "h", role: "user" });
    await expect(repo.create({ email: "DUP@x.co", passwordHash: "h", role: "user" }))
      .rejects.toBeInstanceOf(EmailTakenError);
  });

  it("findById returns the row; list() returns all", async () => {
    const repo = createUserRepo(await createTestDb());
    const a = await repo.create({ email: "a@x.co", passwordHash: "h", role: "admin" });
    await repo.create({ email: "b@x.co", passwordHash: "h", role: "user" });
    expect((await repo.findById(a.id))?.role).toBe("admin");
    expect((await repo.list()).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `users.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../schema";
import type { Db } from "./db";
import { EmailTakenError } from "@/server/auth/errors";

export type UserRow = typeof users.$inferSelect;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserRepo(db: Db) {
  return {
    async create(input: { email: string; passwordHash: string; role: "user" | "admin" }): Promise<UserRow> {
      const email = normalizeEmail(input.email);
      const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) throw new EmailTakenError(email);
      const [row] = await db
        .insert(users)
        .values({ email, passwordHash: input.passwordHash, role: input.role })
        .returning();
      return row;
    },
    async findByEmail(email: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
      return row ?? null;
    },
    async findById(id: string): Promise<UserRow | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
    async list(): Promise<UserRow[]> {
      return db.select().from(users).orderBy(asc(users.createdAt));
    },
  };
}

export const usersRepo: ReturnType<typeof createUserRepo> = {
  create: (i) => createUserRepo(getDb()).create(i),
  findByEmail: (e) => createUserRepo(getDb()).findByEmail(e),
  findById: (i) => createUserRepo(getDb()).findById(i),
  list: () => createUserRepo(getDb()).list(),
};
```

- [ ] **Step 4: Run to verify it passes** (this requires `auth/errors.ts` from Task 8 to exist — if executing strictly in order, create the `EmailTakenError` stub now; Task 8 fills the rest).

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): users repo with lowercase-email uniqueness"`

---

## Task 6: sessions repo

**Files:**
- Create: `src/server/persistence/repos/sessions.ts`
- Test: `src/server/persistence/repos/sessions.test.ts`

**Interfaces:**
- Consumes: `Db`, `sessions` + `users` tables.
- Produces: `createSessionRepo(db)` → `{ create({userId, tokenHash}), findUserByTokenHash(tokenHash), deleteByTokenHash(tokenHash) }`. `findUserByTokenHash` returns the joined `UserRow | null` (touches `lastUsedAt`). Exported singleton `sessionsRepo`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { createSessionRepo } from "./sessions";

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [u] = await db.insert(users).values({ email: "s@x.co", passwordHash: "h", role: "user" }).returning();
  return u;
}

describe("sessionsRepo", () => {
  it("create then findUserByTokenHash returns the owning user", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "abc123" });
    const found = await repo.findUserByTokenHash("abc123");
    expect(found?.id).toBe(u.id);
    expect(found?.role).toBe("user");
  });

  it("findUserByTokenHash returns null for an unknown token", async () => {
    const repo = createSessionRepo(await createTestDb());
    expect(await repo.findUserByTokenHash("nope")).toBeNull();
  });

  it("deleteByTokenHash logs the user out (row gone)", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "tok" });
    await repo.deleteByTokenHash("tok");
    expect(await repo.findUserByTokenHash("tok")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `sessions.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { sessions, users } from "../schema";
import type { Db } from "./db";
import type { UserRow } from "./users";

export function createSessionRepo(db: Db) {
  return {
    async create(input: { userId: string; tokenHash: string }): Promise<void> {
      await db.insert(sessions).values({ userId: input.userId, tokenHash: input.tokenHash });
    },
    async findUserByTokenHash(tokenHash: string): Promise<UserRow | null> {
      const [row] = await db
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      await db.update(sessions).set({ lastUsedAt: sql`now()` }).where(eq(sessions.tokenHash, tokenHash));
      return row.user;
    },
    async deleteByTokenHash(tokenHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
  };
}

export const sessionsRepo: ReturnType<typeof createSessionRepo> = {
  create: (i) => createSessionRepo(getDb()).create(i),
  findUserByTokenHash: (t) => createSessionRepo(getDb()).findUserByTokenHash(t),
  deleteByTokenHash: (t) => createSessionRepo(getDb()).deleteByTokenHash(t),
};
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): sessions repo (hashed-token lookup + logout)"`

---

## Task 7: wire types + ErrorCode extension

**Files:**
- Modify: `src/types/index.ts`
- Test: extend `src/types/index.test.ts`

**Interfaces:**
- Produces: `ErrorCode` gains `"UNAUTHORIZED"`, `"FORBIDDEN"`. New schemas: `AuthUser` (`{id, email, role}` — never the hash), `RegisterRequest` (`{email, password}`), `LoginRequest` (`{email, password}`), `SessionResponse` (`{user: AuthUser}`).

- [ ] **Step 1: Write the failing test** (append to `index.test.ts`)

```ts
import { AuthUser, RegisterRequest, ErrorCode } from "./index";

it("ErrorCode includes the auth codes", () => {
  expect(ErrorCode.options).toContain("UNAUTHORIZED");
  expect(ErrorCode.options).toContain("FORBIDDEN");
});

it("AuthUser never carries a password hash", () => {
  const parsed = AuthUser.parse({ id: "u1", email: "a@b.co", role: "user", passwordHash: "leak" });
  expect(parsed).not.toHaveProperty("passwordHash"); // strip via .parse
});

it("RegisterRequest enforces a minimum password length", () => {
  expect(RegisterRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — add `UNAUTHORIZED`, `FORBIDDEN` to the `ErrorCode` enum array, and append the auth schemas:

```ts
export const AuthUser = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["user", "admin"]),
}); // .parse() strips unknown keys (e.g. passwordHash) by default
export type AuthUser = z.infer<typeof AuthUser>;

export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionResponse = z.object({ user: AuthUser });
export type SessionResponse = z.infer<typeof SessionResponse>;
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): auth wire schemas + UNAUTHORIZED/FORBIDDEN codes"`

---

## Task 8: auth errors module

**Files:**
- Create: `src/server/auth/errors.ts` (if not already stubbed in Task 5)
- Test: covered indirectly by repo/route tests.

**Interfaces:**
- Produces: `UnauthorizedError`, `ForbiddenError`, `EmailTakenError`, `InvalidCredentialsError` — each an `Error` subclass with a stable `name`.

- [ ] **Step 1: Implement**

```ts
export class UnauthorizedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
export class ForbiddenError extends Error {
  constructor(message = "Admin access required.") {
    super(message);
    this.name = "ForbiddenError";
  }
}
export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`);
    this.name = "EmailTakenError";
  }
}
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "InvalidCredentialsError";
  }
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` → no errors from these.

- [ ] **Step 3: Commit** — `git commit -m "feat(auth): auth error classes"`

---

## Task 9: getSession / requireUser / requireAdmin

**Files:**
- Create: `src/server/auth/session.ts`
- Test: `src/server/auth/session.test.ts`

**Interfaces:**
- Consumes: `sessionsRepo.findUserByTokenHash`, `hashToken`, `UnauthorizedError`/`ForbiddenError`, `next/headers` `cookies()`, React `cache`.
- Produces: `SESSION_COOKIE = "caliber_session"`; `sessionCookieOptions(raw)` / `clearedCookieOptions()` for route handlers; `getSession(): Promise<AuthUser | null>`; `requireUser(): Promise<AuthUser>`; `requireAdmin(): Promise<AuthUser>`; `resolveSessionFromToken(raw: string | undefined): Promise<AuthUser | null>` (pure, testable without `cookies()`).

**Testability note:** `cookies()` from `next/headers` needs a request scope, awkward in a unit test. Split the logic: `resolveSessionFromToken(raw)` is pure (takes the raw token, returns the user or null) and is what the tests exercise; `getSession()` is a thin `cache()`-wrapped reader that pulls the cookie and delegates to it.

- [ ] **Step 1: Write failing tests for `resolveSessionFromToken`** (mock the repo, mirror the existing `vi.mock("@/server/persistence/db")` seam used by route tests)

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const findUserByTokenHash = vi.fn();
vi.mock("@/server/persistence/repos/sessions", () => ({
  sessionsRepo: { findUserByTokenHash: (t: string) => findUserByTokenHash(t) },
}));

import { resolveSessionFromToken } from "./session";
import { hashToken } from "./token";

beforeEach(() => findUserByTokenHash.mockReset());

describe("resolveSessionFromToken", () => {
  it("returns null when there is no token", async () => {
    expect(await resolveSessionFromToken(undefined)).toBeNull();
    expect(findUserByTokenHash).not.toHaveBeenCalled();
  });

  it("looks up by the SHA-256 hash of the raw token and returns AuthUser", async () => {
    findUserByTokenHash.mockResolvedValue({ id: "u1", email: "a@b.co", role: "admin", passwordHash: "h", createdAt: new Date() });
    const user = await resolveSessionFromToken("raw-token");
    expect(findUserByTokenHash).toHaveBeenCalledWith(hashToken("raw-token"));
    expect(user).toEqual({ id: "u1", email: "a@b.co", role: "admin" }); // hash stripped
  });

  it("returns null for an unknown token", async () => {
    findUserByTokenHash.mockResolvedValue(null);
    expect(await resolveSessionFromToken("ghost")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `session.ts`**

```ts
import { cache } from "react";
import { cookies } from "next/headers";
import { AuthUser } from "@/types";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashToken } from "./token";
import { UnauthorizedError, ForbiddenError } from "./errors";

export const SESSION_COOKIE = "caliber_session";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

// Secure in prod; overridable for local http via SESSION_COOKIE_SECURE=false.
const secure = process.env.SESSION_COOKIE_SECURE !== "false";

export function sessionCookieOptions(raw: string) {
  return { name: SESSION_COOKIE, value: raw, httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: THIRTY_DAYS };
}
export function clearedCookieOptions() {
  return { name: SESSION_COOKIE, value: "", httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: 0 };
}

export async function resolveSessionFromToken(raw: string | undefined): Promise<AuthUser | null> {
  if (!raw) return null;
  const row = await sessionsRepo.findUserByTokenHash(hashToken(raw));
  if (!row) return null;
  return AuthUser.parse(row); // strips passwordHash/createdAt
}

export const getSession = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  return resolveSessionFromToken(store.get(SESSION_COOKIE)?.value);
});

export async function requireUser(): Promise<AuthUser> {
  const user = await getSession();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new ForbiddenError();
  return user;
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): getSession + requireUser/requireAdmin guards"`

---

## Task 10: auth route handlers

**Files:**
- Create: `src/app/api/auth/register/route.ts`, `login/route.ts`, `logout/route.ts`, `session/route.ts`
- Test: `src/app/api/auth/auth.route.test.ts` (mock the repos via the existing db-mock seam)

**Interfaces:**
- Consumes: `usersRepo`, `sessionsRepo`, `hashPassword`/`verifyPassword`, `mintSessionToken`, `sessionCookieOptions`/`clearedCookieOptions`, `getSession`, the auth Zod schemas, error classes.
- Produces: `POST /api/auth/register` (201, sets cookie, auto-login), `POST /api/auth/login` (200, sets cookie), `POST /api/auth/logout` (204, clears cookie), `GET /api/auth/session` (200 `SessionResponse` | 401).

Registration inserts `role: "user"` literally. All four are POST-or-GET only; mutations are POST (SameSite=Lax + POST-only is the CSRF floor). Each maps errors:
- `ZodError` → 422 `VALIDATION_ERROR`
- `EmailTakenError` → 409 `CONFLICT`
- `InvalidCredentialsError` → 401 `UNAUTHORIZED`
- `UnauthorizedError` → 401 `UNAUTHORIZED`
- `ForbiddenError` → 403 `FORBIDDEN`

- [ ] **Step 1: Write failing route tests** (one file exercising the happy paths + the key failures)

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const usersRepo = { create: vi.fn(), findByEmail: vi.fn() };
const sessionsRepo = { create: vi.fn(), deleteByTokenHash: vi.fn(), findUserByTokenHash: vi.fn() };
vi.mock("@/server/persistence/repos/users", () => ({ usersRepo }));
vi.mock("@/server/persistence/repos/sessions", () => ({ sessionsRepo }));

import { POST as register } from "./register/route";
import { POST as login } from "./login/route";
import { hashPassword } from "@/server/auth/password";

beforeEach(() => { vi.clearAllMocks(); });

describe("POST /api/auth/register", () => {
  it("creates a 'user'-role account, auto-logs-in, sets an httpOnly cookie", async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    sessionsRepo.create.mockResolvedValue(undefined);
    const res = await register(new Request("http://x/api/auth/register", {
      method: "POST", body: JSON.stringify({ email: "a@b.co", password: "longenough" }),
    }) as any);
    expect(res.status).toBe(201);
    expect(usersRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: "user" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("caliber_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });
});

describe("POST /api/auth/login", () => {
  it("rejects a wrong password with 401 UNAUTHORIZED", async () => {
    usersRepo.findByEmail.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user", passwordHash: await hashPassword("right") });
    const res = await login(new Request("http://x/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: "a@b.co", password: "wrong" }),
    }) as any);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the four handlers.** Register (the others follow the same shape — see the error-mapping table above):

```ts
// src/app/api/auth/register/route.ts
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RegisterRequest, AuthUser, type ErrorEnvelope } from "@/types";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword } from "@/server/auth/password";
import { mintSessionToken } from "@/server/auth/token";
import { sessionCookieOptions } from "@/server/auth/session";
import { EmailTakenError } from "@/server/auth/errors";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

export async function POST(request: Request) {
  let json: unknown;
  try { json = await request.json(); } catch { return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body."); }
  try {
    const { email, password } = RegisterRequest.parse(json);
    const user = await usersRepo.create({ email, passwordHash: await hashPassword(password), role: "user" });
    const { raw, hash } = mintSessionToken();
    await sessionsRepo.create({ userId: user.id, tokenHash: hash });
    const res = NextResponse.json({ user: AuthUser.parse(user) }, { status: 201 });
    res.cookies.set(sessionCookieOptions(raw));
    return res;
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid registration.", err.issues);
    if (err instanceof EmailTakenError) return errorResponse(409, "CONFLICT", err.message);
    throw err;
  }
}
```

Login: `findByEmail` → `verifyPassword` → `InvalidCredentialsError` (401) on miss → mint session + cookie, 200 `{ user }`. Logout: read cookie, `deleteByTokenHash(hashToken(raw))`, return 204 with `clearedCookieOptions()`. Session: `getSession()` → 200 `SessionResponse` or 401 `UNAUTHORIZED`.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): register/login/logout/session routes"`

---

## Task 11: register the auth routes in the contract + flip the auth note

**Files:**
- Modify: `src/contract/registry.ts`, `src/contract/generate.ts`
- Test: `src/contract/route-coverage.test.ts` (already exists — must pass), `contract:check`

**Interfaces:** Consumes the auth Zod schemas + `registry.registerPath`.

- [ ] **Step 1: Register the 4 paths** in `registry.ts` (mirror the existing `/api/profile` block). Also add `AuthUser`, `RegisterRequest`, `LoginRequest`, `SessionResponse`, `ErrorEnvelope` (already present) to the `zodToOpenAPIRegistry.add` loop where a named component is wanted.

```ts
registry.registerPath({
  method: "post", path: "/api/auth/register",
  summary: "Register an account (auto-login)",
  request: { body: { content: { "application/json": { schema: RegisterRequest } } } },
  responses: {
    201: { description: "Created + session cookie set", content: { "application/json": { schema: SessionResponse } } },
    409: { description: "Email already registered", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});
// ...login (post), logout (post, 204 no body), session (get, 200 SessionResponse | 401)
```

- [ ] **Step 2: Flip the auth note** in `generate.ts`:

```ts
const AUTH_NOTE = "Auth: email+password sessions (httpOnly cookie). requireUser()/requireAdmin() guard route handlers; no Next middleware.";
```

- [ ] **Step 3: Regenerate + verify coverage**

```bash
npm run contract           # regenerates contract/openapi.json
npm test -- src/contract/route-coverage.test.ts
```
Expected: route-coverage PASS (all 4 new routes registered), `contract/openapi.json` updated.

- [ ] **Step 4: Run `npm run contract:check`** — expect exit 0 (regenerated file matches committed).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(auth): register auth routes in OpenAPI contract"`

---

## Task 12: seed the bootstrap admin

**Files:**
- Modify: `src/server/persistence/seed.ts`
- Test: `src/server/persistence/seed.test.ts` (extend)

**Interfaces:** Consumes `BOOTSTRAP_ADMIN_ID`, `hashPassword`, `users` table.

- [ ] **Step 1: Write the failing test**

```ts
import { seedAdmin } from "./seed";
import { users } from "./schema";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { verifyPassword } from "@/server/auth/password";

it("seedAdmin upserts the fixed-UUID admin from env creds", async () => {
  const db = await createTestDb();
  await seedAdmin(db, { email: "admin@x.co", password: "adminpass1" });
  const [row] = await db.select().from(users).where(eq(users.id, BOOTSTRAP_ADMIN_ID));
  expect(row.role).toBe("admin");
  expect(row.email).toBe("admin@x.co");
  expect(await verifyPassword(row.passwordHash, "adminpass1")).toBe(true);
});

it("seedAdmin is idempotent (re-run updates creds, no duplicate)", async () => {
  const db = await createTestDb();
  await seedAdmin(db, { email: "admin@x.co", password: "one12345" });
  await seedAdmin(db, { email: "admin@x.co", password: "two12345" });
  const rows = await db.select().from(users);
  expect(rows.length).toBe(1);
  expect(await verifyPassword(rows[0].passwordHash, "two12345")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `seedAdmin`** in `seed.ts` (add alongside `seedSources`/`seedProfile`; wire into the module-main guard, reading env and failing loud if unset):

```ts
export async function seedAdmin(db: Db, creds: { email: string; password: string }) {
  const passwordHash = await hashPassword(creds.password);
  const email = creds.email.trim().toLowerCase();
  return db
    .insert(users)
    .values({ id: BOOTSTRAP_ADMIN_ID, email, passwordHash, role: "admin" })
    .onConflictDoUpdate({ target: users.id, set: { email, passwordHash, role: "admin" } })
    .returning();
}
```

In the module-main guard:

```ts
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the admin.");
await seedAdmin(db, { email, password });
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- src/server/persistence/seed.test.ts`

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): seed bootstrap admin from ADMIN_EMAIL/ADMIN_PASSWORD"`

---

## Task 13: env + docs reconciliation

**Files:**
- Modify: `.env.example`, `docs/architecture/api-contract.md`

- [ ] **Step 1: Add env vars to `.env.example`**

```
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-locally
# Set to false only for local http (dev); leave unset/true in prod so the session cookie is Secure.
SESSION_COOKIE_SECURE=true
```

- [ ] **Step 2: Update `api-contract.md`** — remove the "every route below is unauthenticated … recorded in OpenAPI as a v1 constraint" line; add an Auth section documenting the 4 routes, the cookie scheme, and `UNAUTHORIZED`/`FORBIDDEN`. (Per-user route semantics + admin routes land in later steps — note them as "forthcoming".)

- [ ] **Step 3: Commit** — `git commit -m "docs(auth): env vars + api-contract auth section"`

---

## Task 14: full-suite gate

- [ ] **Step 1: Run the whole suite** — `npm test` → all green (789 prior + new auth tests).
- [ ] **Step 2: Typecheck + contract + build** — `npm run check` (typecheck && vitest && contract:check && build).
- [ ] **Step 3: Manual smoke** (real Postgres, per the `verify` skill): seed admin, `curl` register → login → session → logout, asserting cookie set/clear and 401-after-logout. Record the transcript.
- [ ] **Step 4: Final commit if any fixes** — then this step is done; proceed to Step 2 (user_id migration), which gets its own plan.

---

## Self-Review

**Spec coverage (against the handoff's approved build-plan step 1 + review.json migrationOrder[1] + decisions 2/6):**
- Hand-rolled auth, users+sessions, argon2id, hashed opaque tokens, httpOnly SameSite=Lax cookie → Tasks 2–6, 9, 10. ✓
- `requireUser()`/`requireAdmin()`, no middleware → Task 9. ✓
- `UNAUTHORIZED`/`FORBIDDEN` in ErrorCode → Task 7. ✓
- Contract-first (Zod registry + route-coverage test stays green) → Tasks 7, 11. ✓
- Seed admin from env against fixed UUID (decision 6, shared with Step 2 backfill) → Tasks 4 (id), 12. ✓
- Role column, admin additive (decision 7 groundwork) → Task 2 (`role` enum), 12. ✓
- Docs-as-canon flip → Tasks 11 (AUTH_NOTE), 13 (api-contract.md). ✓
- **Deferred to later steps (correctly out of scope here):** per-user data slicing (Step 2/3), open-registration gating tripwire (decision 3 — no invite code now; flagged for pre-VPS), session expiry (decision 4 — none), admin content routes (Step 6/7), frontend auth chrome (Step 4).

**Placeholder scan:** no TBD/TODO; every code step shows real code. The only forward-reference is `auth/errors.ts` (Task 8) used by Task 5 — call-out included to stub `EmailTakenError` early if executing strictly in order.

**Type consistency:** `AuthUser` = `{id,email,role}` everywhere; `UserRow` includes `passwordHash` (DB) and is narrowed to `AuthUser` via `.parse()` at every wire boundary (session.ts, routes). `mintSessionToken()` → `{raw,hash}`; `hashToken(raw)` used identically in token.ts, session.ts, logout. Repo singletons match the `profileRepo` shape.

**Open decision surfaced for the operator (does not block Task 1):** decision #3 locked *open* registration, but this plan's `/api/auth/register` has no invite gate. That's intentional per the lock — the tripwire is "add gating before public VPS exposure," which is a deployment-step concern, not an auth-core concern. Flagging so it isn't lost.
