// OpenRouter transport (OpenAI-compatible API — see `openai` npm package).
// This is a leaf module: never import server/*, features/*, or UI here.
import OpenAI from "openai";
import { z } from "zod";
import { makeMockLlm } from "./mock";
import { modelFor, priceFor } from "./models";
import { scriptedFixtures } from "./scripted-fixtures";

export type TaskName =
  | "resume-extract"
  | "jd-extract"
  | "match-score"
  | "question-extract"
  | "question-answer"
  | "tailor"
  | "url-check-search"
  | "ghost-web";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  complete<T>(args: {
    task: TaskName;
    modelOverride?: string;
    messages: LlmMessage[];
    responseSchema: z.ZodType<T>;
    signal?: AbortSignal;
  }): Promise<{ data: T; model: string; costUsd: number }>;
}

function buildClient(transport: OpenAI): LlmClient {
  return {
    async complete(args) {
      const { task, modelOverride, messages, responseSchema, signal } = args;
      const config = modelFor(task);
      const model = modelOverride ?? config.model;

      // zod@4 derives JSON Schema natively; the OpenAI SDK's `schema` field
      // types as `{ [key: string]: unknown }` (an index signature), which
      // z.toJSONSchema's concrete return type doesn't structurally satisfy —
      // hence the cast.
      const jsonSchema = z.toJSONSchema(responseSchema) as Record<string, unknown>;

      // NOTE: `strict: false`, not true. OpenAI's structured-output strict
      // mode requires every property to appear in `required` (no optional
      // fields) — but our response schemas use `.optional()` throughout, so
      // strict mode 400s ("'required' ... Missing '<field>'"). The schema
      // still guides generation; `responseSchema.parse(parsed)` below is the
      // real enforcement, so any deviation fails loud there.
      const completion = await transport.chat.completions.create(
        {
          model,
          messages,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          // gpt-oss-120b bills reasoning tokens against max_tokens; "low"
          // caps that overhead so structured extraction doesn't truncate.
          // Absent from config → provider default (an explicit choice, not a
          // silent fallback).
          ...(config.reasoningEffort !== undefined ? { reasoning_effort: config.reasoningEffort } : {}),
          response_format: {
            type: "json_schema",
            json_schema: { name: task, schema: jsonSchema, strict: false },
          },
        },
        { signal },
      );

      const choice = completion.choices[0];
      if (choice?.finish_reason === "length") {
        throw new Error(
          `Completion truncated (hit max_tokens=${config.maxTokens}) for task "${task}" — raise maxTokens in config/models.yml`,
        );
      }

      const content = choice?.message?.content;
      if (!content) throw new Error(`Empty completion content for task "${task}"`);

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`Unparseable JSON in completion for task "${task}": ${content}`);
      }

      const data = responseSchema.parse(parsed);

      const usage = completion.usage;
      if (!usage) throw new Error(`Missing token usage in completion for task "${task}"`);
      const price = priceFor(model);
      const costUsd =
        (usage.prompt_tokens / 1_000_000) * price.promptUsdPerMTok +
        (usage.completion_tokens / 1_000_000) * price.completionUsdPerMTok;

      return { data, model, costUsd };
    },
  };
}

// Fail-loud: honored only on exact "1"; any other set value throws.
export function testDoublesEnabled(): boolean {
  const v = process.env.CALIBER_TEST_DOUBLES;
  if (v === undefined || v === "") return false;
  if (v !== "1") throw new Error(`CALIBER_TEST_DOUBLES set to unexpected value "${v}" (only "1" enables test doubles)`);
  return true;
}

export function getLlm(): LlmClient {
  if (testDoublesEnabled()) return makeMockLlm(scriptedFixtures);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const transport = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey });
  return buildClient(transport);
}
