// OpenRouter transport (OpenAI-compatible API — see `openai` npm package).
// This is a leaf module: never import server/*, features/*, or UI here.
import OpenAI from "openai";
import { z } from "zod";
import { modelFor, priceFor } from "./models";

export type TaskName =
  | "resume-extract"
  | "jd-extract"
  | "match-score"
  | "question-extract"
  | "question-answer"
  | "tailor";

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

      const completion = await transport.chat.completions.create(
        {
          model,
          messages,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          response_format: {
            type: "json_schema",
            json_schema: { name: task, schema: jsonSchema, strict: true },
          },
        },
        { signal },
      );

      const content = completion.choices[0]?.message?.content;
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

export function getLlm(): LlmClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const transport = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey });
  return buildClient(transport);
}
