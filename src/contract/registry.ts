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
  EligibilityTier,
  Eligibility,
  SourceRef,
  Source,
  RelocationPref,
  Profile,
  Job,
  Resume,
  RunStatus,
  Progress,
  SearchRun,
  ScanResult,
  SearchRunSummary,
  ScanDetail,
  Application,
  ApplicationQuestion,
  ApplicationAnswer,
  ApplicationAnswers,
  TailoredResume,
  CorrelationReport,
  ErrorEnvelope,
  SummaryStripStats,
  SseEvent,
  UrlCheck,
  UrlCheckRequest,
  UrlChecksSnapshot,
  AuthUser,
  RegisterRequest,
  LoginRequest,
  ChangePasswordRequest,
  SessionResponse,
  AdminUser,
  AdminUsersResponse,
  AdminPlanPatch,
  AdminGrantRequest,
  CreditsResponse,
  ClientErrorReport,
  SourceHealthRow,
  SourcesHealthResponse,
} from "@/types";

const entitySchemas: Record<string, z.ZodType> = {
  Persona,
  LegitimacyTier,
  Tone,
  Legitimacy,
  EligibilityTier,
  Eligibility,
  SourceRef,
  Source,
  RelocationPref,
  Profile,
  Job,
  Resume,
  RunStatus,
  Progress,
  SearchRun,
  ScanResult,
  SearchRunSummary,
  ScanDetail,
  Application,
  ApplicationQuestion,
  ApplicationAnswer,
  ApplicationAnswers,
  TailoredResume,
  CorrelationReport,
  ErrorEnvelope,
  SummaryStripStats,
  SseEvent,
  UrlCheck,
  UrlCheckRequest,
  UrlChecksSnapshot,
  AuthUser,
  RegisterRequest,
  LoginRequest,
  ChangePasswordRequest,
  SessionResponse,
  AdminUser,
  AdminUsersResponse,
  AdminPlanPatch,
  AdminGrantRequest,
  CreditsResponse,
  ClientErrorReport,
  SourceHealthRow,
  SourcesHealthResponse,
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
          schema: z.object({ ok: z.boolean(), mode: z.enum(["real", "doubles"]), llmKeyConfigured: z.boolean() }),
        },
      },
    },
    503: {
      description: "DB ping failed — UptimeRobot + alert-check.sh depend on this to detect on-box outages",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(false) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/profile",
  summary: "The caller's profile — base country + relocation preference",
  responses: {
    200: { description: "The caller's profile", content: { "application/json": { schema: Profile } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "The caller has no profile row yet (PUT to onboard)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/profile",
  summary: "Create-or-replace the caller's profile (onboarding path)",
  request: { body: { content: { "application/json": { schema: Profile.omit({ updatedAt: true }) } } } },
  responses: {
    200: { description: "The created/updated profile", content: { "application/json": { schema: Profile } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/credits",
  summary: "Wallet balance + plan for the header chip",
  responses: {
    200: { description: "Wallet balance and plan", content: { "application/json": { schema: CreditsResponse } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
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
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
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
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "No résumé uploaded yet", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/search",
  summary: "Start a dual search run (global ATS + MY boards) — F2 discovery",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            persona: Persona,
            sources: z.array(z.string()).min(1).optional().describe("Omitted = persona's full configured set"),
          }),
        },
      },
    },
  },
  responses: {
    202: { description: "Run queued", content: { "application/json": { schema: SearchRun } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    409: {
      description: "A run is already active for this persona, or no résumé exists",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
    422: { description: "Invalid body (e.g. an explicit empty sources[])", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/search",
  summary: "List the caller's past scans — paginated, newest-first (Scans tab)",
  request: {
    query: z.object({
      limit: z.string().optional().describe("Positive integer, max 50 (default 20)"),
      cursor: z.string().optional().describe("Opaque keyset cursor from a prior page's nextCursor"),
    }),
  },
  responses: {
    200: {
      description: "A page of the caller's scan runs",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(SearchRunSummary), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid limit or malformed cursor", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/search/{id}",
  summary: "Run status — JSON snapshot (ScanDetail) by default; SSE via Accept: text/event-stream",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description:
        "ScanDetail JSON snapshot (persisted per-job results + widened stats), or an SSE stream of progress/job/done/error (B6)",
      content: {
        "application/json": { schema: ScanDetail },
        "text/event-stream": { schema: SseEvent },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown run id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs",
  summary: "Scored feed — filterable, cursored — F2 (B6)",
  request: {
    query: z.object({
      persona: Persona.optional(),
      tier: z.array(LegitimacyTier).optional().describe("repeatable"),
      minScore: z.number().min(0).max(5).optional(),
      isNew: z.boolean().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("default 25"),
    }),
  },
  responses: {
    200: {
      description: "Page of scored jobs + hero stats computed server-side over the full scoped set",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(Job), nextCursor: z.string().nullable(), stats: SummaryStripStats }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Unknown query parameter or invalid value", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{id}",
  summary: "Single job incl. applyUrl — F2/F3 (B6)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The frozen Job (no separate detail entity)", content: { "application/json": { schema: Job } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/jobs/{id}",
  summary: "Delete a pasted job — persona 'pasted' only, blocked by a tracked application (spec §10, Task 14)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
    409: {
      description: "Job is not persona 'pasted', or a tracked application exists",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{id}/evaluate",
  summary: "On-demand re-score of a single job — F2 (Task 6)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The freshly re-scored, frozen Job", content: { "application/json": { schema: Job } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Malformed or unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "No active résumé to score against", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "No job description obtainable — nothing to extract facts from", content: { "application/json": { schema: ErrorEnvelope } } },
    500: { description: "Unexpected failure", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/check",
  summary: "Check a pasted job URL/text — F7 pasted-job ingestion",
  request: {
    body: {
      content: {
        "application/json": { schema: UrlCheckRequest },
      },
    },
  },
  responses: {
    200: {
      description: "Already-known job — completed short-circuit, zero spend",
      content: { "application/json": { schema: UrlCheck } },
    },
    202: { description: "Pipeline queued", content: { "application/json": { schema: UrlCheck } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "No active résumé to score against", content: { "application/json": { schema: ErrorEnvelope } } },
    422: {
      description: "Invalid body/URL, or pasted text exceeds the 40k-character cap",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/check",
  summary: "Batched url-check snapshot — poll — parallel scoring",
  request: {
    query: z.object({
      active: z.literal("1").optional().describe('Set to "1" to return in-flight (queued/running) rows'),
      ids: z.string().optional().describe("Comma-separated url_check ids"),
    }),
  },
  responses: {
    200: { description: "The requested url_checks, plus worker pause state", content: { "application/json": { schema: UrlChecksSnapshot } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Neither ?active=1 nor ?ids= was provided", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/check/{id}",
  summary: "URL-check status — poll — F7",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The UrlCheck row", content: { "application/json": { schema: UrlCheck } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown or foreign-owned check id", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/apply/questions",
  summary: "Extract application questions from a posting — F4 tier 1/2/3 (B7)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            jobId: z.string().optional(),
            url: z.string().optional(),
            pastedForm: z.string().optional(),
          }).describe("Exactly one of jobId, url, or pastedForm must be provided"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Extracted questions + the posting URL they came from (null for the paste tier)",
      content: {
        "application/json": {
          schema: z.object({ questions: z.array(ApplicationQuestion), sourceUrl: z.string().nullable() }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Zero or more than one of jobId/url/pastedForm provided", content: { "application/json": { schema: ErrorEnvelope } } },
    502: {
      description: "No structured ATS API matched and DOM parsing found no form — never returns [] as a guess",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/apply/answers",
  summary: "Draft résumé-grounded answers for extracted questions — F4 (B7)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ jobId: z.string(), questions: z.array(ApplicationQuestion).min(1) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Persisted, résumé-grounded answer set", content: { "application/json": { schema: ApplicationAnswers } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "No résumé exists to ground answers against", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body (e.g. empty questions[])", content: { "application/json": { schema: ErrorEnvelope } } },
    502: { description: "LLM drafting failed", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tailor",
  summary: "Start tailoring the résumé to a job — F6 (B8)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ jobId: z.string(), reportId: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    202: { description: "Tailor run queued", content: { "application/json": { schema: TailoredResume } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "No résumé exists to tailor", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tailor/{id}",
  summary: "Tailor status + result — JSON snapshot by default; SSE via Accept: text/event-stream — F6 (B8)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "JSON snapshot, or an SSE stream of progress/done/error (stages analyze -> rewrite -> render -> done)",
      content: {
        "application/json": { schema: TailoredResume },
        "text/event-stream": { schema: SseEvent },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown tailor run id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tailor/correlate",
  summary: "Start correlating the résumé against the job's requirements — F6 (B8)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ jobId: z.string() }),
        },
      },
    },
  },
  responses: {
    202: { description: "Correlation run queued", content: { "application/json": { schema: CorrelationReport } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "No résumé exists to correlate", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tailor/correlate/{id}",
  summary: "Correlation status + result — JSON snapshot by default; SSE via Accept: text/event-stream — F6 (B8)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "JSON snapshot, or an SSE stream of progress/done/error (stages extract -> classify -> verify -> done)",
      content: {
        "application/json": { schema: CorrelationReport },
        "text/event-stream": { schema: SseEvent },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown correlation run id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tailor/{id}/finalize",
  summary: "Persist the accepted-only diff — renders an accepted-only résumé — F6 (B8)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ acceptedIndices: z.array(z.number().int()) }),
        },
      },
    },
  },
  responses: {
    200: { description: "TailoredResume server-rendered with only the accepted diff entries applied", content: { "application/json": { schema: TailoredResume } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown tailor run id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "Run has not completed yet", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tailor/{id}/pdf",
  summary: "Rendered PDF of the finalized (accepted-only) résumé — F6 (B8)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Binary PDF bytes",
      content: { "application/pdf": { schema: z.string().describe("Binary PDF bytes") } },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown tailor run id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "Run has not been finalized yet (POST .../finalize not yet called, or status !== 'completed')", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/apply/answers/{id}",
  summary: "Edit a persisted answer set (user edits or per-question regenerate) — F4 (B7)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ answers: z.array(ApplicationAnswer).min(1) }),
        },
      },
    },
  },
  responses: {
    200: { description: "The replaced answer set", content: { "application/json": { schema: ApplicationAnswers } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown answers id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Empty patch (answers[] with zero entries)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/applications",
  summary: "Mark a job applied — persists a stage-0 tracker row — F5 (B9)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            jobId: z.string(),
            note: z.string().optional(),
            tailoredResumeId: z.string().optional(),
            answersId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Server sets appliedAt, stage:0, statusLabel/statusTone via features/applied/status-map.ts",
      content: { "application/json": { schema: Application } },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown job id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    409: {
      description:
        "Duplicate jobId (details: { existingId }), job exists but isn't scored yet, or no active résumé to record",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/applications",
  summary: "List tracker rows — filterable, cursored — F5 (B9)",
  request: {
    query: z.object({
      stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
      statusTone: z.enum(["good", "verified", "neutral"]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Page of tracker rows",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(Application), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Unknown query parameter or invalid value", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/applications/{id}",
  summary: "Update stage / status / note / tailored flag — F5 (B9)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
            statusLabel: z.string().optional(),
            statusTone: z.enum(["good", "verified", "neutral"]).optional(),
            note: z.string().optional(),
            tailored: z.boolean().optional(),
            tailoredResumeId: z.string().nullable().optional(),
            answersId: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "The updated Application", content: { "application/json": { schema: Application } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown application id (incl. a foreign-owned one — no existence leak)", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Empty patch (zero fields)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/sources",
  summary: "Sources management: every row, both personas, disabled included, ordered by name",
  responses: {
    200: {
      description: "All source rows",
      content: { "application/json": { schema: z.object({ items: z.array(Source) }) } },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/sources/{id}",
  summary: "Enable/disable a source — id is a TEXT natural key (e.g. 'gh-stripe'), not a uuid",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: { description: "The updated Source", content: { "application/json": { schema: Source } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown source id", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body (enabled must be a boolean)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users",
  summary: "Admin: every account with per-user résumé/job/application counts",
  responses: {
    200: { description: "All users with counts", content: { "application/json": { schema: AdminUsersResponse } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/sources",
  summary: "Admin: source-health surface — total/enabled/dead counts + dead/disabled rows (Track O §4.3)",
  responses: {
    200: { description: "Source-health aggregates + the dead/disabled rows", content: { "application/json": { schema: SourcesHealthResponse } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{id}/resume",
  summary: "Admin: fetch the target user's résumé (decision #7 full content access)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Target user's current résumé", content: { "application/json": { schema: Resume } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown/non-uuid user id, or the target has no résumé", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{id}/jobs",
  summary: "Admin: the target user's scored feed (decision #7 full content access)",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      persona: Persona.optional(),
      tier: z.array(LegitimacyTier).optional().describe("repeatable"),
      minScore: z.number().min(0).max(5).optional(),
      isNew: z.boolean().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("default 25"),
    }),
  },
  responses: {
    200: {
      description:
        "Page of the target user's scored jobs + hero stats; an empty feed (not an error) when the target has no profile yet",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(Job), nextCursor: z.string().nullable(), stats: SummaryStripStats }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Non-uuid user id", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{id}/applications",
  summary: "Admin: the target user's tracker rows (decision #7 full content access)",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
      statusTone: z.enum(["good", "verified", "neutral"]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Page of the target user's tracker rows",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(Application), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Non-uuid user id", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/admin/users/{id}",
  summary: "Admin: toggle a user's plan (standard/unlimited)",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AdminPlanPatch } } },
  },
  responses: {
    200: { description: "The updated AdminUser", content: { "application/json": { schema: AdminUser } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown/non-uuid user id", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body (plan must be 'standard' or 'unlimited')", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{id}/credits",
  summary: "Admin: grant (or debit) credits by an arbitrary non-zero delta",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AdminGrantRequest } } },
  },
  responses: {
    200: {
      description: "The user's new balance",
      content: { "application/json": { schema: z.object({ balance: z.number().int() }) } },
    },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Unknown/non-uuid user id", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body (delta must be a non-zero integer)", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/register",
  summary: "Register an account (auto-login)",
  request: { body: { content: { "application/json": { schema: RegisterRequest } } } },
  responses: {
    201: { description: "Created + session cookie set", content: { "application/json": { schema: SessionResponse } } },
    403: { description: "Invalid invite code", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "Email already registered", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Too many registrations from this IP", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  summary: "Log in with email + password",
  request: { body: { content: { "application/json": { schema: LoginRequest } } } },
  responses: {
    200: { description: "Session cookie set", content: { "application/json": { schema: SessionResponse } } },
    401: { description: "Invalid credentials", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  summary: "Log out",
  responses: {
    204: { description: "Logged out; session cookie cleared" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/session",
  summary: "Current session",
  responses: {
    200: { description: "Active session", content: { "application/json": { schema: SessionResponse } } },
    401: { description: "No active session", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/auth/password",
  summary: "Self-serve change-password — reverifies current password, kills other sessions, re-mints the caller's",
  request: { body: { content: { "application/json": { schema: ChangePasswordRequest } } } },
  responses: {
    200: { description: "Password changed; fresh session cookie set", content: { "application/json": { schema: SessionResponse } } },
    401: { description: "No session, or wrong current password", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid body", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/client-error",
  summary: "Crash beacon — client error report (fire-and-forget; userId attached server-side)",
  request: { body: { content: { "application/json": { schema: ClientErrorReport } } } },
  responses: {
    204: { description: "Report accepted" },
    413: { description: "Report exceeds the size cap", content: { "application/json": { schema: ErrorEnvelope } } },
    422: { description: "Invalid report shape", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Per-IP report limit exceeded", content: { "application/json": { schema: ErrorEnvelope } } },
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
