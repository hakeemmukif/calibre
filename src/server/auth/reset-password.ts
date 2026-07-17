// Operator password-reset runbook (pre-launch hardening Task 6, Decision 2).
// GENERATES a password and prints it once — never accepts one via argv (a
// shared-box shell history would leak it). Two-invocation flow: dry-run by
// default, `--confirm` mutates and kills every session for the user.
//
// Usage (locally; on the box prefix with `docker compose run --rm app`):
//   npm run auth:reset-password -- someone@example.com            # dry-run
//   npm run auth:reset-password -- someone@example.com --confirm  # resets
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/server/persistence/db";
import { sessions, users } from "@/server/persistence/schema";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword } from "./password";

// Typeable + unambiguous: no 0/O, 1/l/I. 12 chars of 54 ≈ 69 bits.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [emailArg, confirmFlag] = process.argv.slice(2);
  if (!emailArg) throw new Error("Usage: npm run auth:reset-password -- <email> [--confirm]");
  const confirm = confirmFlag === "--confirm";
  const db = getDb();
  (async () => {
    const [user] = await db.select().from(users).where(eq(users.email, emailArg.trim().toLowerCase()));
    if (!user) throw new Error(`No user with email ${emailArg}`);
    const [{ n }] = await db.select({ n: count() }).from(sessions).where(eq(sessions.userId, user.id));
    console.log(`user ${user.email} (${user.id}) — ${n} live session(s) will be killed.`);
    if (!confirm) {
      console.log("Dry-run only. Re-run with --confirm to reset the password.");
      process.exit(0);
    }
    const password = generatePassword();
    await usersRepo.updatePasswordHash(user.id, await hashPassword(password));
    await sessionsRepo.deleteAllByUserId(user.id);
    console.log(`New password for ${user.email}: ${password}`);
    console.log("All sessions killed. Share over a private channel; the user should change it on /profile.");
    process.exit(0); // libsql keeps the process alive otherwise (seed.ts idiom)
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
