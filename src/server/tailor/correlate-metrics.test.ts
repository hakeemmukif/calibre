import { describe, expect, it } from "vitest";
import type { ResumeStore } from "@/server/resume/resume-store";
import { atsSignal, fabricationViolations, flattenResumeText, semanticSignal, verifyEvidence } from "./correlate-metrics";

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

describe("fabricationViolations", () => {
  const base = store; // reuse the fixture above
  it("flags a rewrite that invents a metric", () => {
    const v = fabricationViolations([{ section: "experience", op: "modify",
      before: "Led distributed payments platform",
      after: "Led distributed payments platform, cutting latency by 40%",
      reason: "r", requirement: "performance", target: { index: 0, bulletIndex: 0 } }], base);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("40");
  });
  it("allows a reword with no new numbers", () => {
    const v = fabricationViolations([{ section: "experience", op: "modify",
      before: "Led distributed payments platform handling FX settlement",
      after: "Architected distributed payment systems for FX settlement",
      reason: "r", requirement: "distributed systems", target: { index: 0, bulletIndex: 0 } }], base);
    expect(v).toEqual([]);
  });
  it("allows a number that already exists in the résumé", () => {
    const withNum: ResumeStore = { ...base, summary: "10 years building payment systems" };
    const v = fabricationViolations([{ section: "summary", op: "modify",
      before: "Built payment systems", after: "10 years building payment platforms",
      reason: "r", requirement: "seniority", target: { index: null, bulletIndex: null } }], withNum);
    expect(v).toEqual([]);
  });
  it("does not flag a cosmetic thousands-separator reformat ($1,200 -> $1200)", () => {
    const withComma: ResumeStore = { ...base, summary: "Managed a $1,200 monthly budget" };
    const v = fabricationViolations([{ section: "summary", op: "modify",
      before: "Managed a $1,200 monthly budget", after: "Managed a $1200 monthly budget",
      reason: "r", requirement: "budget", target: { index: null, bulletIndex: null } }], withComma);
    expect(v).toEqual([]);
  });
  it("does not flag the reverse thousands-separator reformat ($1200 -> $1,200)", () => {
    const withoutComma: ResumeStore = { ...base, summary: "Managed a $1200 monthly budget" };
    const v = fabricationViolations([{ section: "summary", op: "modify",
      before: "Managed a $1200 monthly budget", after: "Managed a $1,200 monthly budget",
      reason: "r", requirement: "budget", target: { index: null, bulletIndex: null } }], withoutComma);
    expect(v).toEqual([]);
  });
  it("still flags a genuinely invented number", () => {
    const v = fabricationViolations([{ section: "summary", op: "modify",
      before: "Built payment systems", after: "Built payment systems worth $1,999",
      reason: "r", requirement: "impact", target: { index: null, bulletIndex: null } }], base);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("1,999");
  });
  it("does not crash on a remove edit with no after", () => {
    const v = fabricationViolations([{ section: "experience", op: "remove",
      before: "Led distributed payments platform handling FX settlement",
      reason: "r", requirement: "trim", target: { index: 0, bulletIndex: 0 } }], base);
    expect(v).toEqual([]);
  });
});
