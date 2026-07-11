// Injectable LlmClient double for tests in every later server/* service —
// no network. Still Zod-validates the canned data so tests catch schema
// drift between a scripted fixture and the caller's responseSchema.
import type { LlmClient, LlmMessage, TaskName } from "./client";

export type ScriptedResponses =
  | Partial<Record<TaskName, unknown>>
  | ((args: { task: TaskName; messages: LlmMessage[] }) => unknown);

export function makeMockLlm(scripted: ScriptedResponses): LlmClient {
  return {
    async complete(args) {
      const canned = typeof scripted === "function" ? scripted({ task: args.task, messages: args.messages }) : scripted[args.task];
      if (canned === undefined) throw new Error(`No scripted response for task "${args.task}"`);
      const data = args.responseSchema.parse(canned);
      return { data, model: "mock", costUsd: 0 };
    },
  };
}
