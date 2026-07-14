import { describe, expect, it } from "vitest";
import { ResumeStoreEmitSchema, emitToStore, type ResumeStoreEmit } from "./resume-store";

// A minimal, fully-populated emit object; each test overrides one slice.
function emit(over: Partial<ResumeStoreEmit> = {}): ResumeStoreEmit {
  return ResumeStoreEmitSchema.parse({
    storeVersion: 2,
    name: "Ada Lovelace",
    headline: null,
    location: null,
    summary: null,
    contact: [],
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
    ...over,
  });
}

describe("emitToStore", () => {
  it("maps nullable scalars to undefined and stamps extractionPath + storeVersion", () => {
    const store = emitToStore(emit({ headline: null, location: null, summary: null }), "text");
    expect(store.headline).toBeUndefined();
    expect(store.location).toBeUndefined();
    expect(store.summary).toBeUndefined();
    expect(store.extractionPath).toBe("text");
    expect(store.storeVersion).toBe(2);
  });

  it("round-trips a flat skill list honestly (label:null)", () => {
    const store = emitToStore(emit({ skills: [{ label: null, items: ["Go", "Go", "Rust"] }] }), "text");
    expect(store.skills[0].label).toBeUndefined();
    expect(store.skills[0].items).toEqual(["Go", "Rust"]); // deduped, order-preserved
  });

  it("coerces start/end to YYYY-MM and derives isCurrent from verbatim dates", () => {
    const store = emitToStore(
      emit({
        experience: [
          { company: "X", title: "Eng", dates: "Jan 2021 – Present", start: "2021-01", end: null, location: null, bullets: [] },
        ],
      }),
      "text",
    );
    expect(store.experience[0].start).toBe("2021-01");
    expect(store.experience[0].end).toBeUndefined();
    expect(store.experience[0].isCurrent).toBe(true);
  });

  it("coerces a malformed date atom to null instead of throwing (availability > fail-loud for one atom)", () => {
    const store = emitToStore(
      emit({
        experience: [
          { company: "X", title: "Eng", dates: "sometime", start: "not-a-date", end: "2020", location: null, bullets: [] },
        ],
      }),
      "text",
    );
    expect(store.experience[0].start).toBeUndefined();
    expect(store.experience[0].end).toBeUndefined();
    expect(store.experience[0].isCurrent).toBe(false);
  });

  it("keeps the résumé's own heading for open-tail sections", () => {
    const store = emitToStore(emit({ sections: [{ heading: "Volunteering", items: ["Red Cross"] }] }), "vision");
    expect(store.sections[0]).toEqual({ heading: "Volunteering", items: ["Red Cross"] });
    expect(store.extractionPath).toBe("vision");
  });

  it("emit schema rejects a missing required field (strict shape)", () => {
    expect(() => ResumeStoreEmitSchema.parse({ name: "X" })).toThrow();
  });
});
