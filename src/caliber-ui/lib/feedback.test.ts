import { describe, expect, it } from "vitest";
import { buildVerdictFeedbackUrl } from "./feedback";
import { jobs } from "../fixtures";

describe("buildVerdictFeedbackUrl (Task 7, Decision 1)", () => {
  const job = jobs[0];
  const url = new URL(buildVerdictFeedbackUrl(job));

  it("targets the Telegram share endpoint (t.me/share/url prefills url + text)", () => {
    expect(url.origin + url.pathname).toBe("https://t.me/share/url");
  });

  it("carries the posting URL and a context block: title, company, tier, job id, lead-in", () => {
    expect(url.searchParams.get("url")).toBe(job.applyUrl);
    const text = url.searchParams.get("text") ?? "";
    expect(text).toContain(job.role);
    expect(text).toContain(job.company);
    expect(text).toContain(job.legitimacy.tier);
    expect(text).toContain(job.id);
    expect(text).toContain("What looks wrong:");
  });

  it("never includes the description (URL-length safe)", () => {
    expect((url.searchParams.get("text") ?? "").length).toBeLessThan(500);
  });
});
