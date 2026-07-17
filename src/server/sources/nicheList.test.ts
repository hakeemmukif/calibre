// Fixtures are real records copied verbatim from the live sources (probe
// 2026-07-17): yc-oss-sample.json from yc-oss/api companies/all.json, and
// remoteintech-sample/*.md from remoteintech/remote-jobs src/companies/.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRemoteInTech, parseYcOss, type NicheCompany } from "./nicheList";

const FIXTURES = join(__dirname, "__fixtures__");

function ycFixture(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "yc-oss-sample.json"), "utf8"));
}

function remoteInTechFixture(): { path: string; content: string }[] {
  const dir = join(FIXTURES, "remoteintech-sample");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ path: join(dir, f), content: readFileSync(join(dir, f), "utf8") }));
}

function find(companies: NicheCompany[], name: string): NicheCompany {
  const hit = companies.find((c) => c.name === name);
  if (!hit) throw new Error(`fixture expectation broken: no company named "${name}"`);
  return hit;
}

describe("parseYcOss", () => {
  it("maps a real record to name + normalized domain + provenance", () => {
    const circuithub = find(parseYcOss(ycFixture()), "CircuitHub");

    expect(circuithub).toEqual({
      name: "CircuitHub",
      domain: "circuithub.com",
      provenance: "yc-oss",
      isHiring: true,
    });
  });

  it("normalizes the website's scheme, www., and path away", () => {
    const companies = parseYcOss(ycFixture());

    // real fixture values: "http://airbnb.com", "https://www.coinbase.com", "picplum.com"
    expect(find(companies, "Airbnb").domain).toBe("airbnb.com");
    expect(find(companies, "Coinbase").domain).toBe("coinbase.com");
    expect(find(companies, "Picplum").domain).toBe("picplum.com");
  });

  it("carries isHiring through in both states", () => {
    const companies = parseYcOss(ycFixture());

    expect(find(companies, "Gusto").isHiring).toBe(true);
    expect(find(companies, "Airbnb").isHiring).toBe(false);
  });

  it("never invents a careersUrl — yc-oss has no careers/jobs URL field", () => {
    for (const company of parseYcOss(ycFixture())) {
      expect(company.careersUrl).toBeUndefined();
    }
  });

  it("skips a record with an empty website and warns with a count (no silent drop, no defaulted domain)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const companies = parseYcOss(ycFixture());

    // "Assembled" is a real fixture record with website: "" — a defunct
    // company. No website means no companyDomain, so it cannot be a
    // NicheCompany.
    expect(companies.some((c) => c.name === "Assembled")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 of 12"));
    expect(warn.mock.calls[0][0]).toContain("Assembled");

    warn.mockRestore();
  });

  it("does not warn when every record has a usable website", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseYcOss([{ name: "Acme", website: "https://acme.example.com", isHiring: true }]);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails loud when the payload is not an array", () => {
    expect(() => parseYcOss({ companies: [] })).toThrow(/array/i);
    expect(() => parseYcOss(null)).toThrow(/array/i);
  });

  it("fails loud when a record is missing the required name", () => {
    expect(() => parseYcOss([{ website: "https://acme.example.com", isHiring: true }])).toThrow(/name/i);
    expect(() => parseYcOss([{ name: "", website: "https://acme.example.com", isHiring: true }])).toThrow(/name/i);
  });

  it("fails loud when a record is not an object", () => {
    expect(() => parseYcOss(["acme"])).toThrow();
  });
});

describe("parseRemoteInTech", () => {
  it("maps a real frontmatter record to name + normalized domain + provenance + careersUrl", () => {
    const automattic = find(parseRemoteInTech(remoteInTechFixture()), "Automattic");

    expect(automattic).toEqual({
      name: "Automattic",
      domain: "automattic.com",
      provenance: "remoteintech",
      careersUrl: "https://automattic.com/work-with-us/",
    });
  });

  it("omits careersUrl when the record has no careers_url (69% populated upstream)", () => {
    const companies = parseRemoteInTech(remoteInTechFixture());

    // real fixture records with no careers_url line: 37signals, 3Blocks, Hotjar
    expect(find(companies, "37signals")).toEqual({
      name: "37signals",
      domain: "37signals.com",
      provenance: "remoteintech",
    });
    expect(find(companies, "3Blocks").careersUrl).toBeUndefined();
    expect(find(companies, "Hotjar").careersUrl).toBeUndefined();
  });

  it("never invents isHiring — remoteintech has no hiring signal", () => {
    for (const company of parseRemoteInTech(remoteInTechFixture())) {
      expect(company.isHiring).toBeUndefined();
    }
  });

  it("parses every .md fixture record", () => {
    expect(parseRemoteInTech(remoteInTechFixture())).toHaveLength(12);
  });

  it("skips a record with a missing website and warns with a count (no silent drop)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Constructed, not a fixture: all 881 .md files in the live snapshot have
    // a website. This pins the behaviour if one ever lands without.
    const companies = parseRemoteInTech([
      { path: "src/companies/acme.md", content: '---\ntitle: "Acme"\nslug: acme\nregion: worldwide\n---\n' },
      { path: "src/companies/widgetco.md", content: '---\ntitle: "Widgetco"\nslug: widgetco\nwebsite: https://widgetco.example.com\n---\n' },
    ]);

    expect(companies.map((c) => c.name)).toEqual(["Widgetco"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 of 2"));
    expect(warn.mock.calls[0][0]).toContain("acme.md");

    warn.mockRestore();
  });

  it("fails loud when the input is not an array", () => {
    expect(() => parseRemoteInTech({} as never)).toThrow(/array/i);
  });

  it("fails loud when a file has no YAML frontmatter", () => {
    expect(() => parseRemoteInTech([{ path: "src/companies/acme.md", content: "## Company blurb\n" }])).toThrow(
      /frontmatter/i,
    );
  });

  it("fails loud when a record is missing the required title", () => {
    expect(() =>
      parseRemoteInTech([{ path: "src/companies/acme.md", content: "---\nslug: acme\nwebsite: https://acme.example.com\n---\n" }]),
    ).toThrow(/title/i);
  });
});
