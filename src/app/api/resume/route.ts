// F1 ingest route — thin boundary: content-type dispatch + Schema.parse,
// error-class → ErrorEnvelope mapping. All DB/LLM access lives in
// server/resume (api-contract.md §3).
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import type { ErrorEnvelope } from "@/types";
import { PdfParseError } from "@/lib/pdf-text";
import { ParseFailedError } from "@/server/resume/derive-view";
import { UnsupportedMimeError } from "@/server/resume/extract-text";
import { getActiveResume, ingestResume } from "@/server/resume/ingest";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PasteBody = z.object({ text: z.string().min(100) });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return errorResponse(422, "VALIDATION_ERROR", "Missing `file` field in multipart form data.");
      }
      if (file.size > MAX_FILE_BYTES) {
        return errorResponse(413, "PAYLOAD_TOO_LARGE", `File exceeds the 10MB limit (${file.size} bytes).`);
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const resume = await ingestResume({ file: { bytes, mime: file.type, filename: file.name } });
      return NextResponse.json(resume, { status: 200 });
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
    }
    const { text } = PasteBody.parse(json);
    const resume = await ingestResume({ text });
    return NextResponse.json(resume, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid résumé payload.", err.issues);
    }
    if (err instanceof UnsupportedMimeError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    if (err instanceof PdfParseError || err instanceof ParseFailedError) {
      return errorResponse(502, "PARSE_FAILED", err.message);
    }
    throw err;
  }
}

export async function GET() {
  const resume = await getActiveResume();
  if (!resume) {
    return errorResponse(404, "NOT_FOUND", "No résumé has been uploaded yet.");
  }
  return NextResponse.json(resume, { status: 200 });
}
