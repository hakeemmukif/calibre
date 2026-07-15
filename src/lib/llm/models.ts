// Parses config/models.yml — the task→model routing table the client reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { TaskName } from "./client";

interface RawTaskConfig {
  model: string;
  escalateTo?: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort?: "low" | "medium" | "high";
  strict?: boolean;
}

interface RawPrice {
  promptUsdPerMTok: number;
  completionUsdPerMTok: number;
}

interface RawConfig {
  tasks: Record<string, RawTaskConfig>;
  prices: Record<string, RawPrice>;
}

const CONFIG_PATH = join(process.cwd(), "config", "models.yml");

let cached: RawConfig | undefined;

function loadConfig(): RawConfig {
  if (!cached) cached = parse(readFileSync(CONFIG_PATH, "utf-8")) as RawConfig;
  return cached;
}

function taskConfig(task: TaskName): RawTaskConfig {
  const config = loadConfig().tasks[task];
  if (!config) throw new Error(`Unknown task "${task}": no entry in config/models.yml`);
  return config;
}

export function modelFor(task: TaskName): {
  model: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort?: "low" | "medium" | "high";
  strict?: boolean;
} {
  const { model, maxTokens, temperature, reasoningEffort, strict } = taskConfig(task);
  return {
    model,
    maxTokens,
    temperature,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(strict !== undefined ? { strict } : {}),
  };
}

export function escalateModelFor(task: TaskName): string | null {
  return taskConfig(task).escalateTo ?? null;
}

export function priceFor(model: string): { promptUsdPerMTok: number; completionUsdPerMTok: number } {
  const price = loadConfig().prices[model];
  if (!price) throw new Error(`No price entry for model "${model}" in config/models.yml`);
  return price;
}
