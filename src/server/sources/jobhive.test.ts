// jobhive CSV ingest — task-2.2 brief (docs/superpowers/specs/
// 2026-07-16-remote-startup-niche-source-expansion-design.md §4.3 step 3):
// "4,848/4,966 greenhouse rows use the new `job-boards.greenhouse.io` host —
// the API host is unaffected, but slug-extraction regex must accept both
// hosts." Vendor schema is `name,slug,url` (§3); this module re-derives
// `slug`+`ats` from `url` rather than trusting the CSV's own slug column, so
// a mislabeled row can never silently pass through.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJobhiveCsv } from "./jobhive";

const FIXTURES = join(__dirname, "__fixtures__");
const SAMPLE_CSV = readFileSync(join(FIXTURES, "jobhive-sample.csv"), "utf-8");

describe("parseJobhiveCsv", () => {
  it("parses greenhouse (legacy host), greenhouse (job-boards host trap), lever, ashby, and quoted-comma-name rows", () => {
    const rows = parseJobhiveCsv(SAMPLE_CSV);

    expect(rows).toEqual([
      { name: "Vercel", slug: "vercel", ats: "greenhouse", url: "https://boards.greenhouse.io/vercel" },
      { name: "Grab", slug: "grab", ats: "greenhouse", url: "https://job-boards.greenhouse.io/grab" },
      { name: "Ramp", slug: "ramp", ats: "lever", url: "https://jobs.lever.co/ramp" },
      { name: "G2", slug: "g2", ats: "ashby", url: "https://jobs.ashbyhq.com/g2" },
      { name: "Porter Cares, Inc.", slug: "porter", ats: "lever", url: "https://jobs.lever.co/porter" },
    ]);
  });

  it("parses a quoted name field containing a comma (real jobhive row)", () => {
    const csv = ["name,slug,url", '"Porter Cares, Inc.",porter,https://jobs.lever.co/porter'].join("\n");

    const rows = parseJobhiveCsv(csv);

    expect(rows).toEqual([
      { name: "Porter Cares, Inc.", slug: "porter", ats: "lever", url: "https://jobs.lever.co/porter" },
    ]);
  });

  it("accepts both boards.greenhouse.io and job-boards.greenhouse.io for the same slug shape", () => {
    const csv = [
      "name,slug,url",
      "Acme,acme,https://boards.greenhouse.io/acme",
      "Acme New Host,acme,https://job-boards.greenhouse.io/acme",
    ].join("\n");

    const rows = parseJobhiveCsv(csv);

    expect(rows[0]).toMatchObject({ ats: "greenhouse", slug: "acme" });
    expect(rows[1]).toMatchObject({ ats: "greenhouse", slug: "acme" });
  });

  it("returns an empty array for a header-only CSV", () => {
    expect(parseJobhiveCsv("name,slug,url\n")).toEqual([]);
  });

  it("throws identifying the row when name is missing", () => {
    const csv = ["name,slug,url", ",acme,https://jobs.lever.co/acme"].join("\n");

    expect(() => parseJobhiveCsv(csv)).toThrow(/row 2/i);
    expect(() => parseJobhiveCsv(csv)).toThrow(/name/i);
  });

  it("throws identifying the row when url is missing", () => {
    const csv = ["name,slug,url", "Acme,acme,"].join("\n");

    expect(() => parseJobhiveCsv(csv)).toThrow(/row 2/i);
    expect(() => parseJobhiveCsv(csv)).toThrow(/url/i);
  });

  it("throws identifying the row and url when the ATS host is unrecognized", () => {
    const csv = ["name,slug,url", "Acme,acme,https://careers.acme.com/jobs"].join("\n");

    expect(() => parseJobhiveCsv(csv)).toThrow(/row 2/i);
    expect(() => parseJobhiveCsv(csv)).toThrow(/careers\.acme\.com/);
  });

  it("throws identifying the row when a data row has the wrong column count", () => {
    const csv = ["name,slug,url", "Acme,acme"].join("\n");

    expect(() => parseJobhiveCsv(csv)).toThrow(/row 2/i);
  });

  it("throws on a header that doesn't match the vendored jobhive schema", () => {
    const csv = ["company,url", "Acme,https://jobs.lever.co/acme"].join("\n");

    expect(() => parseJobhiveCsv(csv)).toThrow(/header/i);
  });
});
