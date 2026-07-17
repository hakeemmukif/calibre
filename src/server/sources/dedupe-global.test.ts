import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  crossBoardKey,
  locationBucket,
  resolveCanonicalCollision,
  type GlobalCanonicalCandidate,
} from "./dedupe-global";

describe("canonicalKey", () => {
  it("anchors on ats:{sourceId}:{externalId} when externalId is present", () => {
    expect(canonicalKey({ sourceId: "greenhouse", externalId: "123", url: "https://boards.greenhouse.io/acme/123" })).toBe(
      "ats:greenhouse:123",
    );
  });

  it("falls back to the normalized-URL key when externalId is absent", () => {
    expect(canonicalKey({ sourceId: "jobstreet", url: "https://jobstreet.com/job/1?utm_source=x" })).toBe(
      "url:jobstreet.com/job/1",
    );
  });

  it("is deterministic — same input always produces the same key (re-crawl stability)", () => {
    const posting = { sourceId: "ashby", externalId: "abc-1", url: "https://jobs.ashbyhq.com/acme/abc-1" };
    expect(canonicalKey(posting)).toBe(canonicalKey({ ...posting }));

    const urlPosting = { sourceId: "jobstreet", url: "https://jobstreet.com/job/9/" };
    expect(canonicalKey(urlPosting)).toBe(canonicalKey({ ...urlPosting }));
  });
});

describe("locationBucket", () => {
  it("buckets remote-keyword locations to 'remote'", () => {
    expect(locationBucket("Remote")).toBe("remote");
    expect(locationBucket("Anywhere")).toBe("remote");
    expect(locationBucket("Work From Home")).toBe("remote");
    expect(locationBucket("Distributed (APAC)")).toBe("remote");
  });

  it("buckets to the city-level segment before the first comma", () => {
    expect(locationBucket("Kuala Lumpur, Malaysia")).toBe("kuala-lumpur");
    expect(locationBucket("Singapore, Singapore")).toBe("singapore");
  });

  it("buckets an absent/empty location to the honest-absence empty string", () => {
    expect(locationBucket(undefined)).toBe("");
    expect(locationBucket("")).toBe("");
    expect(locationBucket("   ")).toBe("");
  });

  it("is case/whitespace insensitive", () => {
    expect(locationBucket("  KUALA LUMPUR , Malaysia  ")).toBe("kuala-lumpur");
  });
});

describe("crossBoardKey", () => {
  it("collides for the same company + role + location bucket across different sources", () => {
    const a = crossBoardKey({ company: "Acme Inc", title: "Senior Backend Engineer", location: "Remote" });
    const b = crossBoardKey({ company: "acme inc", title: "Backend Engineer", location: "anywhere" });
    expect(a).toBe(b);
  });

  it("under-merge safety: distinct locations never collapse to the same key", () => {
    const kl = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Kuala Lumpur, Malaysia" });
    const sg = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Singapore, Singapore" });
    expect(kl).not.toBe(sg);
  });

  it("under-merge safety: distinct companies never collapse to the same key", () => {
    const acme = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Remote" });
    const other = crossBoardKey({ company: "Other Corp", title: "Backend Engineer", location: "Remote" });
    expect(acme).not.toBe(other);
  });

  it("under-merge safety: distinct role tokens never collapse to the same key", () => {
    const backend = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Remote" });
    const frontend = crossBoardKey({ company: "Acme Inc", title: "Frontend Engineer", location: "Remote" });
    expect(backend).not.toBe(frontend);
  });

  it("accepted over-merge case: same company+role posted 'remote' in two regions collapses (documented in arch §4)", () => {
    const a = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Remote - US" });
    const b = crossBoardKey({ company: "Acme Inc", title: "Backend Engineer", location: "Remote - EU" });
    expect(a).toBe(b);
  });
});

describe("resolveCanonicalCollision", () => {
  const ats: GlobalCanonicalCandidate = { tier: "ats", sourceId: "greenhouse", canonicalKey: "ats:greenhouse:1" };
  const board: GlobalCanonicalCandidate = { tier: "board", sourceId: "jobstreet", canonicalKey: "url:jobstreet.com/job/1" };
  const aggregator: GlobalCanonicalCandidate = {
    tier: "aggregator",
    sourceId: "himalayas",
    canonicalKey: "url:himalayas.app/job/1",
  };

  it("same job from two boards → one canonical row; ATS-direct wins regardless of argument order", () => {
    expect(resolveCanonicalCollision(ats, board)).toEqual({ canonical: ats, alias: board });
    expect(resolveCanonicalCollision(board, ats)).toEqual({ canonical: ats, alias: board });
  });

  it("board beats aggregator regardless of argument order", () => {
    expect(resolveCanonicalCollision(board, aggregator)).toEqual({ canonical: board, alias: aggregator });
    expect(resolveCanonicalCollision(aggregator, board)).toEqual({ canonical: board, alias: aggregator });
  });

  it("ats beats aggregator", () => {
    expect(resolveCanonicalCollision(ats, aggregator)).toEqual({ canonical: ats, alias: aggregator });
  });

  it("falls back to the first argument when tiers tie", () => {
    const boardB: GlobalCanonicalCandidate = { tier: "board", sourceId: "hiredly", canonicalKey: "url:hiredly.com/job/1" };
    expect(resolveCanonicalCollision(board, boardB)).toEqual({ canonical: board, alias: boardB });
  });
});
