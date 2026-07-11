// Contract registry — collects the frozen src/types entities plus the
// endpoints that exist today into an @asteasolutions/zod-to-openapi
// OpenAPIRegistry. `src/contract/generate.ts` turns this into the committed
// contract/openapi.json; later slices (B4+) register their own paths by
// importing `registry` from here and calling `registry.registerPath({...})`
// before generation runs — no changes needed in this file.
//
// Component schemas are NOT registered via `registry.register(name, schema)`.
// In this library's v8 API, `.register()` calls `zodSchema.openapi(refId)`,
// which (a) requires `extendZodWithOpenApi(z)` to have already patched the
// exact schema instance *before it was constructed* (zod v4 installs
// `.openapi` per-instance at construction time, so patch-after-import is too
// late — `src/types` is a normal static import, evaluated before any code in
// this file runs), and (b) even when that ordering is forced, `.openapi()`
// returns a *new* schema instance rather than tagging the original, so a
// nested reference (e.g. `Job.source: SourceRef`) still points at the
// untagged original and gets inlined instead of `$ref`'d.
//
// Instead we tag the original schema instances in place via the library's
// own internal metadata registry (`zodToOpenAPIRegistry`, publicly exported
// for exactly this kind of advanced use — see its "use with caution"
// docstring). This preserves identity, so nested fields correctly resolve to
// `$ref`s, and it has no import-order dependency.
import { OpenAPIRegistry, zodToOpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  Persona,
  LegitimacyTier,
  Tone,
  Legitimacy,
  SourceRef,
  Job,
  Resume,
  RunStatus,
  Progress,
  SearchRun,
  Application,
  ApplicationQuestion,
  ApplicationAnswer,
  ApplicationAnswers,
  TailoredResume,
  ErrorEnvelope,
  SummaryStripStats,
} from "@/types";

const entitySchemas: Record<string, z.ZodType> = {
  Persona,
  LegitimacyTier,
  Tone,
  Legitimacy,
  SourceRef,
  Job,
  Resume,
  RunStatus,
  Progress,
  SearchRun,
  Application,
  ApplicationQuestion,
  ApplicationAnswer,
  ApplicationAnswers,
  TailoredResume,
  ErrorEnvelope,
  SummaryStripStats,
};

for (const [name, schema] of Object.entries(entitySchemas)) {
  zodToOpenAPIRegistry.add(schema, { _internal: { refId: name } });
}

export const registry = new OpenAPIRegistry();

registry.registerPath({
  method: "get",
  path: "/api/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/resume",
  summary: "Upload (PDF/DOCX) or paste a résumé — F1 ingest",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({ file: z.string().describe("PDF or DOCX file, ≤10MB") }),
        },
        "application/json": {
          schema: z.object({ text: z.string().min(100) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Parsed résumé", content: { "application/json": { schema: Resume } } },
    413: { description: "File exceeds the 10MB limit", content: { "application/json": { schema: ErrorEnvelope } } },
    422: {
      description: "Bad mime type or too-short/missing text",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
    502: {
      description: "Extraction or LLM structuring failed — no résumé persisted",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/resume",
  summary: "Fetch the current résumé",
  responses: {
    200: { description: "Current résumé", content: { "application/json": { schema: Resume } } },
    404: { description: "No résumé uploaded yet", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

type SchemaDefinition = { type: "schema"; schema: z.ZodType };

// Exported so generate.ts can assert every frozen entity actually landed in
// `document.components.schemas` — a future zod-to-openapi bump can't
// silently emit empty/partial components without failing the build.
export const entityNames = Object.keys(entitySchemas);

// The full definitions list `generate.ts` (or any future consumer) should
// build the document from — the tagged entity component schemas above, plus
// whatever paths are registered on `registry` (ours, and B4+'s later).
export function getDefinitions() {
  const schemaDefinitions: SchemaDefinition[] = Object.values(entitySchemas).map((schema) => ({
    type: "schema",
    schema,
  }));
  return [...schemaDefinitions, ...registry.definitions];
}
