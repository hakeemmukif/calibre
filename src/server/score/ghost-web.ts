// Ghost posting-history web-evidence task (spec
// 2026-07-12-pasted-job-ingestion-design.md §8): asks perplexity/sonar to
// search for sightings of a specific company + title posting. NEVER
// throws — the paste pipeline must complete even when the search
// provider is flaky (§6 "ghost-check ... throw → webEvidence:
// {status:'failed'}, pipeline continues"). Sightings are the model's
// only output; count90d/oldestDays/tier effects are computed
// deterministically by the legitimacy overlay, never asked of the model
// (§8 "no model-invented numbers").
import type { LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { GhostWebEvidence, type WebEvidence } from "@/types";

export async function fetchGhostWebEvidence(
  llm: LlmClient,
  company: string,
  title: string,
): Promise<{ webEvidence: WebEvidence; costUsd: number }> {
  try {
    const { data, costUsd } = await llm.complete({
      task: "ghost-web",
      messages: renderTemplate("ghost-web", { company, title }),
      responseSchema: GhostWebEvidence,
    });
    return { webEvidence: { status: "ok", ...data }, costUsd };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { webEvidence: { status: "failed", reason }, costUsd: 0 };
  }
}
