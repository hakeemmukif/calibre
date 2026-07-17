import { describe, expect, it } from "vitest";
import { generatePassword } from "./reset-password";

describe("generatePassword (Task 6 reset script)", () => {
  it("emits 12 typeable chars from the unambiguous alphabet (no 0/O/1/l/I)", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
  });

  it("two invocations differ (not a fixed string)", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
