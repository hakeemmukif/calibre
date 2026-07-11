// F5 tracker patch route — thin boundary: Schema.parse + non-empty check +
// error mapping. All DB access lives in server/tracker/index.ts
// (api-contract.md §3 "PATCH /api/applications/:id").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { patchApplication } from "@/server/tracker";
import type { ErrorEnvelope } from "@/types";

const StatusTone = z.enum(["good", "verified", "neutral"]);
const Stage = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const RequestBody = z
  .object({
    stage: Stage.optional(),
    statusLabel: z.string().optional(),
    statusTone: StatusTone.optional(),
    note: z.string().optional(),
    tailored: z.boolean().optional(),
    tailoredResumeId: z.string().nullable().optional(),
    answersId: z.string().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Empty patch — at least one field is required." });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  try {
    const body = RequestBody.parse(json);
    const app = await patchApplication(id, body);
    if (!app) {
      return errorResponse(404, "NOT_FOUND", `No application with id "${id}".`);
    }
    return NextResponse.json(app, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid application patch.", err.issues);
    }
    throw err;
  }
}
