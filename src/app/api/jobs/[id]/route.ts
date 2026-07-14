// GET /api/jobs/:id (api-contract.md §3) — no separate detail entity; the
// frozen Job is returned verbatim, JobDetail's tabs derive client-side from
// fit/legitimacy/breakdown.
import { NextRequest, NextResponse } from "next/server";
import { assembleJob } from "@/features/feed/assemble";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
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

  try {
    const session = await requireUser();
    const joined = await jobsRepo.getById(id, session.id);
    if (!joined) {
      return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
    }

    const cutoff = await resolveIsNewCutoff(session.id, joined.job.persona);
    return NextResponse.json(assembleJob(joined, { isNewCutoff: cutoff }), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }

  try {
    const session = await requireUser();
    await deletePastedJob(id, session.id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
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
