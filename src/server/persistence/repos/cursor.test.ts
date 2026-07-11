import { describe, expect, it } from "vitest";
import { InvalidCursorError, decodeCursorId, encodeCursorId } from "./cursor";

describe("decodeCursorId", () => {
  it("round-trips a valid id via encodeCursorId", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect(decodeCursorId(encodeCursorId(id))).toEqual({ id });
  });

  it("throws InvalidCursorError for valid JSON missing a string id", () => {
    const cursor = Buffer.from(JSON.stringify({ notId: "whatever" })).toString("base64url");
    expect(() => decodeCursorId(cursor)).toThrow(InvalidCursorError);
  });

  it("throws InvalidCursorError when id is present but not a uuid", () => {
    const cursor = Buffer.from(JSON.stringify({ id: "not-a-uuid" })).toString("base64url");
    expect(() => decodeCursorId(cursor)).toThrow(InvalidCursorError);
  });
});
