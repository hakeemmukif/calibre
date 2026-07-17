// Top-N scoring-path detail backfill. Posting-first since P.5's pool cutover
// (arch §3 step 6): a pool-admitted job reads its full JD from the linked
// `postings` row (crawl-time D2 full text) instead of re-fetching; only a job
// with no pooled JD (a pasted job, or a board search API that carried none)
// falls back to the connector's detail fetch. Persist behavior is UNCHANGED —
// the resolved JD is written to `jobs.description` here, right before scoring,
// so the hidden downstream consumers (evaluate/tailor/answers, which read
// `jobs.description`) are untouched by the cutover. Called by run.ts's
// scoreTopCandidates loop (TOP_N_CANDIDATES-bounded) and Task 6's per-job
// evaluate endpoint, never during discovery.
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import { postingsRepo } from "@/server/persistence/repos/postings";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting } from "./connector";
import { connectorForSource } from "./connectors";

const DESCRIPTION_CAP = 40_000;

// `postingDescription`: the linked posting's stored JD, resolved by the caller
// (run.ts batches one `getForScoring` over the whole TOP_N). Passing it
// (string OR null) means "I already resolved the posting — do not re-query";
// omitting it (evaluate's per-job path) makes this self-resolve from
// `job.postingId`, so both paths are posting-first.
export async function ensureDescription(
  job: JobRow,
  source: SourceRow,
  postingDescription?: string | null,
): Promise<JobRow> {
  if (job.description && job.description.trim().length > 0) return job;

  const callerResolvedPosting = postingDescription !== undefined;
  let poolText = postingDescription ?? null;
  if (!callerResolvedPosting && job.postingId) {
    const [posting] = await postingsRepo.getForScoring([job.postingId]);
    poolText = posting?.description ?? null;
  }
  if (poolText && poolText.trim().length > 0) {
    return jobsRepo.updateDescription(job.id, job.userId, poolText.slice(0, DESCRIPTION_CAP));
  }

  const connector = connectorForSource(source);
  if (!connector.fetchDetail) return job;

  const posting: RawPosting = { sourceId: source.id, url: job.url, title: job.title, company: job.company };
  const detail = await connector.fetchDetail(posting);
  const description = detail.description.slice(0, DESCRIPTION_CAP);
  if (!description.trim()) return job;

  return jobsRepo.updateDescription(job.id, job.userId, description);
}
