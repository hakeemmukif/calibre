// Template registry over config/templates/<task>.md.
//
// File format: a sequence of blocks, each starting with a delimiter line
// `--- system ---` or `--- user:<name> ---`, followed by the block's body
// (everything up to the next delimiter or EOF). `{{var}}` placeholders in
// a body are filled from the `vars` passed to renderTemplate. The block
// named `user:candidate` (the candidate/résumé data) is ALWAYS emitted
// LAST in the returned message array, regardless of where it sits in the
// file — this mirrors the donor's eval/prompts.ts fixed block order for
// prompt-caching discipline.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmMessage, TaskName } from "./client";

const TEMPLATES_DIR = join(process.cwd(), "config", "templates");
const DELIMITER_RE = /^---\s*(system|user:[\w-]+)\s*---$/;

interface Block {
  role: "system" | "user";
  name: string;
  body: string;
}

function templatePath(task: TaskName): string {
  return join(TEMPLATES_DIR, `${task}.md`);
}

function readTemplateFile(task: TaskName): string {
  try {
    return readFileSync(templatePath(task), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Unknown task "${task}": no template at config/templates/${task}.md`);
    }
    throw err;
  }
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let current: { role: "system" | "user"; name: string; lines: string[] } | undefined;

  const flush = () => {
    if (current) blocks.push({ role: current.role, name: current.name, body: current.lines.join("\n").trim() });
  };

  for (const line of source.split("\n")) {
    const match = DELIMITER_RE.exec(line.trim());
    if (match) {
      flush();
      const tag = match[1];
      current = tag === "system" ? { role: "system", name: "system", lines: [] } : { role: "user", name: tag.slice("user:".length), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

function fillVars(body: string, vars: Record<string, string>, task: TaskName): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in vars)) throw new Error(`Missing template variable "${name}" for task "${task}"`);
    return vars[name];
  });
}

export function renderTemplate(task: TaskName, vars: Record<string, string>): LlmMessage[] {
  const blocks = parseBlocks(readTemplateFile(task));
  const candidateIndex = blocks.findIndex((b) => b.name === "candidate");
  const ordered =
    candidateIndex === -1
      ? blocks
      : [...blocks.slice(0, candidateIndex), ...blocks.slice(candidateIndex + 1), blocks[candidateIndex]];
  return ordered.map((b) => ({ role: b.role, content: fillVars(b.body, vars, task) }));
}

export function policyVersion(task: TaskName): string {
  return createHash("sha256").update(readTemplateFile(task), "utf-8").digest("hex").slice(0, 12);
}
