import { describe, expect, it } from "vitest";
import { isUuid } from "./params";

describe("isUuid", () => {
  it("accepts a canonical v4 uuid", () => {
    expect(isUuid("2f8a9c1e-4b6d-4f2a-9e3c-1a2b3c4d5e6f")).toBe(true);
  });
  it("rejects a non-uuid string", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("123")).toBe(false);
  });
});
