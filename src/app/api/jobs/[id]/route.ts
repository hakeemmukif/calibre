// GET /api/jobs/:id (api-contract.md §3) — no separate detail entity; the
// frozen Job is returned verbatim, JobDetail's tabs derive client-side from
// fit/legitimacy/breakdown.
import { NextRequest, NextResponse } from "next/server";
import { assembleJob } from "@/features/feed/assemble";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resolveIsNewCutoff } from "@/server/search/jobsFeed";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const joined = await jobsRepo.getById(id);
  if (!joined) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }

  const cutoff = await resolveIsNewCutoff(joined.job.persona);
  return NextResponse.json(assembleJob(joined, { isNewCutoff: cutoff }), { status: 200 });
}
