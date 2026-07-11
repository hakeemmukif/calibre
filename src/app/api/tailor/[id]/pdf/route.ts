// F6 PDF export route — thin boundary. Renders the finalized (accepted-only)
// résumé via server/tailor's renderTailorPdf (api-contract.md §3
// "GET /api/tailor/:id/pdf"). Real Chromium is never launched in tests —
// they mock "@/lib/pdf" (see src/lib/pdf.ts's deferred base-image gate note).
import { NextRequest, NextResponse } from "next/server";
import { RunNotReadyError, UnknownTailorIdError, renderTailorPdf } from "@/server/tailor";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const pdf = await renderTailorPdf(id);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  } catch (err) {
    if (err instanceof UnknownTailorIdError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof RunNotReadyError) {
      return errorResponse(409, "RUN_NOT_READY", err.message);
    }
    throw err;
  }
}
