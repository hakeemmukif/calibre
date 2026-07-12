import { describe, expect, it } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { searchForPosting, UrlSearchResult } from "./search-tier";

describe("searchForPosting", () => {
  it("returns found:true with content and sourceNote when the model locates the posting", async () => {
    const llm = makeMockLlm({
      "url-check-search": {
        found: true,
        content: "Senior Engineer at Acme — full JD text...",
        sourceNote: "Google cache",
      },
    });

    const result = await searchForPosting(llm, "https://acme.example/jobs/123", "Senior Engineer - Acme");

    expect(result).toEqual({
      found: true,
      content: "Senior Engineer at Acme — full JD text...",
      sourceNote: "Google cache",
      costUsd: 0,
    });
  });

  it("returns found:false with empty content when the specific posting can't be located", async () => {
    const llm = makeMockLlm({
      "url-check-search": {
        found: false,
        content: "",
        sourceNote: "no matching posting found",
      },
    });

    const result = await searchForPosting(llm, "https://acme.example/jobs/gone");

    expect(result.found).toBe(false);
    expect(result.content).toBe("");
    expect(result.sourceNote).toBe("no matching posting found");
  });

  it("passes the URL and an optional pageTitle scrap into the template without a pageTitle", async () => {
    const llm = makeMockLlm(({ messages }) => {
      const joined = messages.map((m) => m.content).join("\n");
      expect(joined).toContain("https://acme.example/jobs/123");
      expect(joined).toContain("(none)");
      return { found: false, content: "", sourceNote: "no matching posting found" };
    });

    await searchForPosting(llm, "https://acme.example/jobs/123");
  });

  it("UrlSearchResult rejects a response missing required fields", () => {
    expect(() => UrlSearchResult.parse({ found: true, content: "x" })).toThrow();
  });
});
