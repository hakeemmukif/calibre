import { describe, expect, it } from "vitest";
import { FUNCTION_TAGS } from "@/server/sources/function";
import { bucketFromTitle, FUNCTION_BUCKET_IDS, TAG_TO_BUCKET } from "./functionBucket";

describe("bucketFromTitle", () => {
  it("has exactly the 12 pinned buckets in order (spec §6)", () => {
    expect(FUNCTION_BUCKET_IDS).toEqual([
      "engineering", "data", "product", "design", "sales", "marketing",
      "cs_support", "people_hr", "finance_legal", "ops_admin", "leadership", "other",
    ]);
  });

  it("engineering: Senior Backend Engineer", () => {
    expect(bucketFromTitle("Senior Backend Engineer")).toBe("engineering");
  });

  it("data: Data Analyst", () => {
    expect(bucketFromTitle("Data Analyst")).toBe("data");
  });

  it("product: Product Manager", () => {
    expect(bucketFromTitle("Product Manager")).toBe("product");
  });

  it("design: UX Designer", () => {
    expect(bucketFromTitle("UX Designer")).toBe("design");
  });

  it("sales: Account Executive", () => {
    expect(bucketFromTitle("Account Executive")).toBe("sales");
  });

  it("marketing: Growth Marketing Manager", () => {
    expect(bucketFromTitle("Growth Marketing Manager")).toBe("marketing");
  });

  it("cs_support: Customer Success Manager", () => {
    expect(bucketFromTitle("Customer Success Manager")).toBe("cs_support");
  });

  it("people_hr: Talent Acquisition Partner", () => {
    expect(bucketFromTitle("Talent Acquisition Partner")).toBe("people_hr");
  });

  it("finance_legal: Finance Manager", () => {
    expect(bucketFromTitle("Finance Manager")).toBe("finance_legal");
  });

  it("ops_admin: Chief of Staff", () => {
    expect(bucketFromTitle("Chief of Staff")).toBe("ops_admin");
  });

  it("leadership: Director, Corporate Development", () => {
    expect(bucketFromTitle("Director, Corporate Development")).toBe("leadership");
  });

  it("other: Warehouse Associate", () => {
    expect(bucketFromTitle("Warehouse Associate")).toBe("other");
  });

  // Pinned collision case (spec §6, verbatim): "Head of Engineering" matches
  // `engineering` (bucket 1, via "engineer") before it ever reaches
  // `leadership` (bucket 11, via "head of") — first-match-wins by BUCKET
  // ORDER, not substring position. Do not "fix" this into leadership.
  it("PINNED collision: 'Head of Engineering' resolves to engineering, not leadership", () => {
    expect(bucketFromTitle("Head of Engineering")).toBe("engineering");
  });

  it("is case-insensitive", () => {
    expect(bucketFromTitle("SENIOR DEVOPS ENGINEER")).toBe("engineering");
  });
});

describe("TAG_TO_BUCKET", () => {
  it("has exactly one entry per P.4 FUNCTION_TAGS value (exhaustive)", () => {
    expect(Object.keys(TAG_TO_BUCKET).sort()).toEqual([...FUNCTION_TAGS].sort());
  });

  it("maps the 6 tags whose spelling diverges from a bucket id to their bucket", () => {
    expect(TAG_TO_BUCKET["customer-success"]).toBe("cs_support");
    expect(TAG_TO_BUCKET.people).toBe("people_hr");
    expect(TAG_TO_BUCKET.finance).toBe("finance_legal");
    expect(TAG_TO_BUCKET.legal).toBe("finance_legal");
    expect(TAG_TO_BUCKET.operations).toBe("ops_admin");
    expect(TAG_TO_BUCKET.executive).toBe("leadership");
  });

  it("maps the 6 tags that already spell a bucket id to themselves", () => {
    expect(TAG_TO_BUCKET.engineering).toBe("engineering");
    expect(TAG_TO_BUCKET.product).toBe("product");
    expect(TAG_TO_BUCKET.design).toBe("design");
    expect(TAG_TO_BUCKET.data).toBe("data");
    expect(TAG_TO_BUCKET.sales).toBe("sales");
    expect(TAG_TO_BUCKET.marketing).toBe("marketing");
  });
});
