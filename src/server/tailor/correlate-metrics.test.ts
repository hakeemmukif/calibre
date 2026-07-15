import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import { atsSignal, flattenResumeText, semanticSignal, verifyEvidence } from "./correlate-metrics";

const store: ResumeStore = {
  storeVersion: 2, extractionPath: "text", name: "Aisha",
  headline: "Backend engineer", location: "KL", summary: "Built payment systems",
  contact: [], education: [], projects: [], certifications: [], languages: [], sections: [],
  experience: [{ company: "Paywatch", title: "Engineer", dates: "2021-2024",
    isCurrent: false,
    bullets: ["Led distributed payments platform handling FX settlement"] }],
  skills: [{ label: "Backend", items: ["Kubernetes", "Postgres"] }],
};

describe("verifyEvidence", () => {
  it("keeps a row whose evidence is in the résumé", () => {
    const [row] = verifyEvidence([{ requirement: "distributed systems experience",
      term: "distributed", kind: "must", status: "met",
      evidence: "Led distributed payments platform", reason: "r", note: null }], store);
    expect(row.status).toBe("met");
  });

  it("downgrades a met row whose evidence is fabricated", () => {
    const [row] = verifyEvidence([{ requirement: "kafka streaming",
      term: "kafka", kind: "must", status: "met",
      evidence: "Built real-time Kafka streaming pipelines", reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.note).toContain("unverifiable");
    expect(row.evidence).toBeNull();
  });

  it("computes atsPresent from the literal term, independent of status", () => {
    const [row] = verifyEvidence([{ requirement: "Kubernetes", term: "Kubernetes",
      kind: "must", status: "gap", evidence: null, reason: "r", note: null }], store);
    expect(row.atsPresent).toBe(true); // present in skills even if the LLM said gap
  });

  it("downgrades a met row with empty-string evidence", () => {
    const [row] = verifyEvidence([{ requirement: "distributed systems experience",
      term: "distributed", kind: "must", status: "met",
      evidence: "", reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.evidence).toBeNull();
    expect(row.reason).toContain("unverifiable");
  });

  it("downgrades a met row with null evidence", () => {
    const [row] = verifyEvidence([{ requirement: "distributed systems experience",
      term: "distributed", kind: "must", status: "met",
      evidence: null, reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.evidence).toBeNull();
    expect(row.reason).toContain("unverifiable");
  });

  it("downgrades a buried row whose evidence is fabricated", () => {
    const [row] = verifyEvidence([{ requirement: "kafka streaming",
      term: "kafka", kind: "nice", status: "buried",
      evidence: "Built real-time Kafka streaming pipelines", reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.evidence).toBeNull();
    expect(row.reason).toContain("unverifiable");
    expect(row.note).toContain("unverifiable");
  });

  it("atsPresent is false for a vacuous term (C++) absent from the résumé", () => {
    const [row] = verifyEvidence([{ requirement: "C++ experience", term: "C++",
      kind: "must", status: "gap", evidence: null, reason: "r", note: null }], store);
    expect(row.atsPresent).toBe(false);
  });

  it("atsPresent is true for a vacuous term (C++) literally present in the résumé", () => {
    const storeWithCpp: ResumeStore = {
      ...store,
      experience: [{ ...store.experience[0], bullets: ["Wrote performance-critical C++ services"] }],
    };
    const [row] = verifyEvidence([{ requirement: "C++ experience", term: "C++",
      kind: "must", status: "gap", evidence: null, reason: "r", note: null }], storeWithCpp);
    expect(row.atsPresent).toBe(true);
  });

  it("verifies a tenure quote against experience dates", () => {
    const [row] = verifyEvidence([{ requirement: "5+ years experience",
      term: "5+ years", kind: "must", status: "met",
      evidence: "Backend Engineer, Paywatch, 2021-2024", reason: "r", note: null }], store);
    expect(row.status).toBe("met");
  });

  it("nulls stray evidence on a gap row", () => {
    const [row] = verifyEvidence([{ requirement: "kafka streaming", term: "kafka",
      kind: "nice", status: "gap", evidence: "some stray quote", reason: "r", note: null }], store);
    expect(row.status).toBe("gap");
    expect(row.evidence).toBeNull();
  });
});

describe("signals", () => {
  const rows = verifyEvidence([
    { requirement: "a", term: "Kubernetes", kind: "must", status: "met", evidence: "Kubernetes", reason: "r", note: null },
    { requirement: "b", term: "Kafka", kind: "must", status: "gap", evidence: null, reason: "r", note: null },
  ], store);
  it("semanticSignal counts by status", () => {
    expect(semanticSignal(rows)).toEqual({ met: 1, buried: 0, gap: 1, total: 2 });
  });
  it("atsSignal lists missing terms", () => {
    const s = atsSignal(rows);
    expect(s.present).toBe(1); expect(s.total).toBe(2); expect(s.missing).toEqual(["Kafka"]);
  });
});

describe("flattenResumeText", () => {
  it("includes text from every ResumeStore section", () => {
    const full: ResumeStore = {
      storeVersion: 2, extractionPath: "text", name: "Aisha",
      headline: "Backend engineer", location: "KL", summary: "Built payment systems",
      contact: [],
      experience: [{ company: "Paywatch", title: "Engineer", dates: "2021-2024",
        isCurrent: false, bullets: ["Led distributed payments platform"] }],
      education: [{ school: "UM", credential: "BSc Computer Science", details: ["Dean's list"] }],
      skills: [{ label: "Backend", items: ["Kubernetes"] }],
      projects: [{ name: "OpenTracker", bullets: ["Built a tracker CLI"] }],
      certifications: [{ name: "AWS SAA" }],
      languages: [{ language: "Malay" }],
      sections: [{ heading: "Volunteering", items: ["Mentored junior engineers"] }],
    };
    const text = flattenResumeText(full);
    for (const expected of [
      "Paywatch", "Led distributed payments platform", "UM", "BSc Computer Science",
      "Dean's list", "Kubernetes", "OpenTracker", "Built a tracker CLI", "AWS SAA",
      "Malay", "Volunteering", "Mentored junior engineers",
    ]) {
      expect(text).toContain(expected);
    }
  });
});
