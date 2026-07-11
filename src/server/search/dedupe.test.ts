import { describe, expect, it } from "vitest";
import {
  companySlugFor,
  dedupeKeyFor,
  resolveCanonicalCollision,
  roleTokensHash,
  secondaryKey,
} from "./dedupe";

describe("dedupeKeyFor", () => {
  it("lowercases the host", () => {
    expect(dedupeKeyFor("https://Boards-API.Greenhouse.io/v1/boards/acme/jobs/123")).toBe(
      "boards-api.greenhouse.io/v1/boards/acme/jobs/123",
    );
  });

  it("strips tracking params (utm_* and known trackers) but keeps other query params, sorted", () => {
    expect(dedupeKeyFor("https://example.com/job/1?b=2&utm_source=linkedin&a=1&gclid=xyz")).toBe(
      "example.com/job/1?a=1&b=2",
    );
  });

  it("drops the fragment", () => {
    expect(dedupeKeyFor("https://example.com/job/1#apply")).toBe("example.com/job/1");
  });

  it("strips a trailing slash but keeps a bare root path", () => {
    expect(dedupeKeyFor("https://example.com/job/1/")).toBe("example.com/job/1");
    expect(dedupeKeyFor("https://example.com/")).toBe("example.com/");
  });

  it("two URLs that only differ by tracking params/case/trailing-slash normalize to the same key", () => {
    const a = dedupeKeyFor("https://Example.com/job/1/?utm_campaign=spring");
    const b = dedupeKeyFor("https://example.com/job/1?fbclid=abc");
    expect(a).toBe(b);
  });
});

describe("companySlugFor / roleTokensHash / secondaryKey", () => {
  it("companySlugFor normalizes to a lowercase alnum-hyphen slug", () => {
    expect(companySlugFor("Acme, Inc.")).toBe("acme-inc");
  });

  it("roleTokensHash is order-independent", () => {
    expect(roleTokensHash("Senior Backend Engineer")).toBe(roleTokensHash("Backend Senior Engineer"));
  });

  it("secondaryKey collides across sources for the same company+role+location", () => {
    const a = secondaryKey({
      companySlug: companySlugFor("Acme Inc"),
      roleTokensHash: roleTokensHash("Senior Backend Engineer"),
      location: "Remote",
    });
    const b = secondaryKey({
      companySlug: companySlugFor("acme inc"),
      roleTokensHash: roleTokensHash("Backend Engineer"),
      location: "remote",
    });
    expect(a).toBe(b);
  });
});

describe("resolveCanonicalCollision", () => {
  it("ATS beats board regardless of argument order", () => {
    const ats = { kind: "ats" as const, sourceId: "greenhouse", url: "https://boards.greenhouse.io/acme/1" };
    const board = { kind: "board" as const, sourceId: "jobstreet", url: "https://jobstreet.com/job/1" };

    expect(resolveCanonicalCollision(ats, board)).toEqual({ canonical: ats, alias: board });
    expect(resolveCanonicalCollision(board, ats)).toEqual({ canonical: ats, alias: board });
  });

  it("falls back to the first argument when kinds tie", () => {
    const boardA = { kind: "board" as const, sourceId: "jobstreet", url: "https://jobstreet.com/job/1" };
    const boardB = { kind: "board" as const, sourceId: "hiredly", url: "https://hiredly.com/job/1" };
    expect(resolveCanonicalCollision(boardA, boardB)).toEqual({ canonical: boardA, alias: boardB });
  });
});
