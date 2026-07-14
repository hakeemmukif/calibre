import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveUpload, resumeKey, uploadsRoot } from "./uploads";

describe("uploadsRoot", () => {
  const original = process.env.CALIBER_UPLOADS_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.CALIBER_UPLOADS_DIR;
    else process.env.CALIBER_UPLOADS_DIR = original;
  });

  it("throws when CALIBER_UPLOADS_DIR is unset", () => {
    delete process.env.CALIBER_UPLOADS_DIR;
    expect(() => uploadsRoot()).toThrow("CALIBER_UPLOADS_DIR is not set");
  });

  it("returns the env value when set", () => {
    process.env.CALIBER_UPLOADS_DIR = "/var/lib/caliber/uploads";
    expect(uploadsRoot()).toBe("/var/lib/caliber/uploads");
  });
});

describe("resumeKey", () => {
  it("builds a relative per-user key with forward slashes", () => {
    expect(resumeKey("u1", "abc", "pdf")).toBe("u1/resumes/abc.pdf");
  });
});

describe("resolveUpload", () => {
  beforeEach(() => {
    process.env.CALIBER_UPLOADS_DIR = "/var/lib/caliber/uploads";
  });

  it("joins the root and the relative key", () => {
    expect(resolveUpload("u1/resumes/abc.pdf")).toBe(join("/var/lib/caliber/uploads", "u1/resumes/abc.pdf"));
  });
});
