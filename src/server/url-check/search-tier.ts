// Tier 2 of the url-check ladder (spec 2026-07-12 §6): fetch failed or its
// extract-gate came back garbage, so fall back to a web search for the
// SAME posting rather than giving up. `found:false` is the only allowed
// outcome when the model can't confirm it's that specific posting — never
// a similar one (template instructs this explicitly; enforcing it here
// would require judging content we can't verify, so it stays a model
// contract, not a code check).
import { z } from "zod";
import type { LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";

export const UrlSearchResult = z.object({
  found: z.boolean(),
  content: z.string(),
  sourceNote: z.string(),
});
export type UrlSearchResult = z.infer<typeof UrlSearchResult>;

export async function searchForPosting(
  llm: LlmClient,
  url: string,
  pageTitle?: string,
): Promise<{ found: boolean; content: string; sourceNote: string; costUsd: number }> {
  const { data, costUsd } = await llm.complete({
    task: "url-check-search",
    messages: renderTemplate("url-check-search", {
      url,
      // pageTitle is a best-effort scrap, genuinely optional (unlike the
      // fail-loud JD facts) — "(none)" tells the model it has no title hint
      // rather than silently rendering an empty line.
      pageTitle: pageTitle ?? "(none)",
    }),
    responseSchema: UrlSearchResult,
  });
  return { found: data.found, content: data.content, sourceNote: data.sourceNote, costUsd };
}
