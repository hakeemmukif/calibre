import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { TailorDiffEntry } from "@/types";
import {
  applyAcceptedDiff,
  applyEdits,
  InvalidDiffIndexError,
  MalformedDiffEditError,
  UnknownDiffSectionError,
} from "./merge";

const base: ResumeStore = {
  storeVersion: 2,
  extractionPath: "text",
  name: "Jane Doe",
  headline: "Engineer",
  location: "Remote",
  summary: "Original summary",
  contact: [],
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      dates: "2020-2022",
      isCurrent: false,
      bullets: ["old0", "old1"],
    },
  ],
  education: [],
  skills: [{ label: "Languages", items: ["TypeScript", "Python"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

const fiveBulletBase: ResumeStore = {
  ...base,
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      dates: "2020-2022",
      isCurrent: false,
      bullets: ["b0", "b1", "b2", "b3", "b4"],
    },
  ],
};

describe("applyEdits", () => {
  it("applies a modify edit to a single bullet, leaving its sibling untouched", () => {
    const edits: TailorDiffEntry[] = [
      {
        section: "experience", op: "modify", before: "old0", after: "new0",
        reason: "r", requirement: "x", target: { index: 0, bulletIndex: 0 },
      },
    ];
    const out = applyEdits(base, edits);
    expect(out.experience[0].bullets[0]).toBe("new0");
    expect(out.experience[0].bullets[1]).toBe("old1");
  });

  it("applies a scalar summary edit", () => {
    const out = applyEdits(base, [
      {
        section: "summary", op: "modify", before: "", after: "S",
        reason: "r", requirement: "z", target: { index: null, bulletIndex: null },
      },
    ]);
    expect(out.summary).toBe("S");
  });

  it("applies an add edit to skills", () => {
    const out = applyEdits(base, [
      {
        section: "skills", op: "add", after: "Go",
        reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
      },
    ]);
    expect(out.skills[0].items).toEqual(["TypeScript", "Python", "Go"]);
  });

  it("applies a remove edit to a bullet, without mutating the input base", () => {
    const out = applyEdits(base, [
      {
        section: "experience", op: "remove", before: "old1",
        reason: "r", requirement: "z", target: { index: 0, bulletIndex: 1 },
      },
    ]);
    expect(out.experience[0].bullets).toEqual(["old0"]);
    expect(base.experience[0].bullets).toEqual(["old0", "old1"]);
  });

  it("throws InvalidDiffIndexError for a bad role index", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "experience", op: "modify", before: "old0", after: "new0",
          reason: "r", requirement: "x", target: { index: 5, bulletIndex: 0 },
        },
      ]),
    ).toThrow(InvalidDiffIndexError);
  });

  it("throws UnknownDiffSectionError for an unrecognized section", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "certifications", op: "modify", before: "", after: "x",
          reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
        },
      ]),
    ).toThrow(UnknownDiffSectionError);
  });

  it("applies a base-relative remove and a later modify in a base-safe order (no index-shift corruption)", () => {
    const edits: TailorDiffEntry[] = [
      {
        section: "experience", op: "remove", before: "b1",
        reason: "r", requirement: "x", target: { index: 0, bulletIndex: 1 },
      },
      {
        section: "experience", op: "modify", before: "b3", after: "X",
        reason: "r", requirement: "y", target: { index: 0, bulletIndex: 3 },
      },
    ];
    const out = applyEdits(fiveBulletBase, edits);
    expect(out.experience[0].bullets).toEqual(["b0", "b2", "X", "b4"]);
  });

  it("applies an add edit to experience bullets (null bulletIndex, matching the skills add convention)", () => {
    const out = applyEdits(base, [
      {
        section: "experience", op: "add", after: "new bullet",
        reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
      },
    ]);
    expect(out.experience[0].bullets).toEqual(["old0", "old1", "new bullet"]);
  });

  it("throws InvalidDiffIndexError for a remove with a null bulletIndex, instead of silently no-oping", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "experience", op: "remove", before: "old0",
          reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
        },
      ]),
    ).toThrow(InvalidDiffIndexError);
  });

  it("throws InvalidDiffIndexError for a modify with a null bulletIndex, instead of silently no-oping", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "experience", op: "modify", before: "old0", after: "x",
          reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
        },
      ]),
    ).toThrow(InvalidDiffIndexError);
  });

  it("throws MalformedDiffEditError for a bullet modify with no after", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "experience", op: "modify", before: "old0",
          reason: "r", requirement: "z", target: { index: 0, bulletIndex: 0 },
        },
      ]),
    ).toThrow(MalformedDiffEditError);
  });

  it("throws MalformedDiffEditError for a bullet add with no after", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "skills", op: "add",
          reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
        },
      ]),
    ).toThrow(MalformedDiffEditError);
  });

  it("throws MalformedDiffEditError for a scalar modify with no after, and does not erase the field", () => {
    expect(() =>
      applyEdits(base, [
        {
          section: "summary", op: "modify", before: "Original summary",
          reason: "r", requirement: "z", target: { index: null, bulletIndex: null },
        },
      ]),
    ).toThrow(MalformedDiffEditError);
    expect(base.summary).toBe("Original summary");
  });
});

describe("applyAcceptedDiff", () => {
  it("accepts one edit and rejects a same-section sibling", () => {
    const edits: TailorDiffEntry[] = [
      {
        section: "experience", op: "modify", before: "old0", after: "A",
        reason: "r", requirement: "x", target: { index: 0, bulletIndex: 0 },
      },
      {
        section: "experience", op: "modify", before: "old1", after: "B",
        reason: "r", requirement: "y", target: { index: 0, bulletIndex: 1 },
      },
    ];
    const out = applyAcceptedDiff(base, edits, [0]); // accept first only
    expect(out.experience[0].bullets[0]).toBe("A");
    expect(out.experience[0].bullets[1]).toBe(base.experience[0].bullets[1]); // reject preserved
  });

  it("throws InvalidDiffIndexError for an out-of-range accepted index", () => {
    const edits: TailorDiffEntry[] = [
      {
        section: "experience", op: "modify", before: "old0", after: "A",
        reason: "r", requirement: "x", target: { index: 0, bulletIndex: 0 },
      },
    ];
    expect(() => applyAcceptedDiff(base, edits, [3])).toThrow(InvalidDiffIndexError);
  });

  it("dedupes accepted indices so a duplicate accept doesn't double-apply", () => {
    const edits: TailorDiffEntry[] = [
      {
        section: "skills", op: "add", after: "Go",
        reason: "r", requirement: "z", target: { index: 0, bulletIndex: null },
      },
    ];
    const out = applyAcceptedDiff(base, edits, [0, 0]);
    expect(out.skills[0].items).toEqual(["TypeScript", "Python", "Go"]);
  });
});
