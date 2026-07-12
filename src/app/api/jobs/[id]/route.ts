// GET /api/jobs/:id (api-contract.md §3) — no separate detail entity; the
// frozen Job is returned verbatim, JobDetail's tabs derive client-side from
// fit/legitimacy/breakdown.
import { NextRequest, NextResponse } from "next/server";
import { assembleJob } from "@/features/feed/assemble";
import { isUuid } from "@/server/http/params";
import { ApplicationExistsError, deletePastedJob, NotDeletableError, UnknownJobError } from "@/server/jobs/delete-job";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resolveIsNewCutoff } from "@/server/search/jobsFeed";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }
  const joined = await jobsRepo.getById(id);
  if (!joined) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }

  const cutoff = await resolveIsNewCutoff(joined.job.persona);
  return NextResponse.json(assembleJob(joined, { isNewCutoff: cutoff }), { status: 200 });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }

  try {
    await deletePastedJob(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof NotDeletableError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof ApplicationExistsError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    throw err;
  }
}
