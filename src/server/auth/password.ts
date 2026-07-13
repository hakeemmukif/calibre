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
