import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Global constraint (pre-launch hardening): NEVER db.transaction() —
// @libsql/client's file: driver recreates its connection when an interactive
// transaction begins; concurrent transactions corrupt state (proven twice,
// 2026-07-16; test-db.ts header). Atomicity = ordered single idempotent
// statements. This test turns the constraint into a build gate: it fails on
// the two live landmines and on any future regression.

const SRC_ROOT = join(__dirname, "../.."); // src/

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...tsFilesUnder(p));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("no db.transaction() anywhere under src/", () => {
  it("finds zero call sites (comment lines excluded)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC_ROOT)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/\.transaction\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
