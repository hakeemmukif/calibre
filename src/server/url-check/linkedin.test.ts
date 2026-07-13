import { describe, expect, it } from "vitest";
import { isLinkedInGuestUrl, normalizeJobUrl } from "./linkedin";

const GUEST_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4388552365";

describe("normalizeJobUrl", () => {
  it("rewrites /jobs/view/{id} and /jobs/view/{id}/ to the guest endpoint", () => {
    expect(normalizeJobUrl(new URL("https://www.linkedin.com/jobs/view/4388552365/")).toString()).toBe(GUEST_URL);
    expect(normalizeJobUrl(new URL("https://www.linkedin.com/jobs/view/4388552365")).toString()).toBe(GUEST_URL);
  });

  it("rewrites a slugged /jobs/view/ path, extracting only the trailing id", () => {
    const url = new URL("https://www.linkedin.com/jobs/view/software-engineer-at-dhl-4388552365");
    expect(normalizeJobUrl(url).toString()).toBe(GUEST_URL);
  });

  it("rewrites ?currentJobId= on /jobs/search/ and /jobs/collections/...", () => {
    expect(
      normalizeJobUrl(new URL("https://www.linkedin.com/jobs/search/?currentJobId=4388552365")).toString(),
    ).toBe(GUEST_URL);
    expect(
      normalizeJobUrl(
        new URL("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4388552365"),
      ).toString(),
    ).toBe(GUEST_URL);
  });

  it("still extracts the id when tracking params are present alongside it", () => {
    const url = new URL(
      "https://www.linkedin.com/jobs/view/4388552365/?refId=abc&trackingId=def&utm_source=share",
    );
    expect(normalizeJobUrl(url).toString()).toBe(GUEST_URL);
  });

  it("normalizes on LinkedIn subdomains", () => {
    expect(normalizeJobUrl(new URL("https://my.linkedin.com/jobs/view/4388552365/")).toString()).toBe(GUEST_URL);
    expect(normalizeJobUrl(new URL("https://sg.linkedin.com/jobs/view/4388552365/")).toString()).toBe(GUEST_URL);
  });

  it("passes through unchanged: non-LinkedIn URL", () => {
    const url = new URL("https://example.com/jobs/view/4388552365");
    expect(normalizeJobUrl(url).toString()).toBe(url.toString());
  });

  it("passes through unchanged: lookalike host", () => {
    const url = new URL("https://linkedin.com.evil.io/jobs/view/123");
    expect(normalizeJobUrl(url).toString()).toBe(url.toString());
  });

  it("passes through unchanged: LinkedIn non-job path", () => {
    const url = new URL("https://www.linkedin.com/in/someone");
    expect(normalizeJobUrl(url).toString()).toBe(url.toString());
  });

  it("passes through unchanged: /jobs/search/ with no currentJobId", () => {
    const url = new URL("https://www.linkedin.com/jobs/search/");
    expect(normalizeJobUrl(url).toString()).toBe(url.toString());
  });

  it("passes through unchanged: non-numeric id", () => {
    const url = new URL("https://www.linkedin.com/jobs/view/abcd");
    expect(normalizeJobUrl(url).toString()).toBe(url.toString());
  });

  it("is idempotent: an already-guest URL stays an equivalent guest URL", () => {
    const url = new URL(GUEST_URL);
    const result = normalizeJobUrl(url);
    expect(result.toString()).toBe(GUEST_URL);
    expect(isLinkedInGuestUrl(result)).toBe(true);
  });
});

describe("isLinkedInGuestUrl", () => {
  it("is true for the guest job-posting path", () => {
    expect(isLinkedInGuestUrl(new URL(GUEST_URL))).toBe(true);
  });

  it("is false for a plain /jobs/view/{id} url", () => {
    expect(isLinkedInGuestUrl(new URL("https://www.linkedin.com/jobs/view/4388552365"))).toBe(false);
  });

  it("is false for a non-LinkedIn host with a guest-shaped path", () => {
    expect(isLinkedInGuestUrl(new URL("https://example.com/jobs-guest/jobs/api/jobPosting/4388552365"))).toBe(false);
  });
});
