// Mechanical scoping-audit gate (Step 3 Task 6 — Fable's cross-cutting
// finding: "no unscoped query survives" is only as good as the enumeration).
// Rather than trust a checklist of "we scoped every read", this test
// enumerates every repos/*.ts file's own query methods and fails BY NAME on
// any that neither filters by userId nor carries an explicit allowlist
// comment. A future read added to any repo — in Steps 5-9 or later — that
// forgets to scope by userId fails this test, not a code-review guess.
//
// Rule: for every exported repo method (a property of the object literal
// returned from `createXRepo(db)`), if that method's body performs a
// `.select(`/`.update(`/`.delete(` query AND has a `.where(` clause, its own
// text must contain EITHER the literal `userId` OR a `// GLOBAL-BY-DECISION:`
// comment. A query with no `.where(` at all (e.g. sources.listAll — every
// row, no filter) has nothing to scope and is not flagged.
//
// Two ways a method can satisfy the rule without inlining `eq(t.userId, ...)`
// itself:
//   1. `// GLOBAL-BY-DECISION: <reason>` — documents WHY this specific query
//      is intentionally cross-tenant (sources reference data, the daily
//      cost-cap sum, worker claim/sweep/attempt-fenced writes, auth-identity
//      lookups that resolve a userId rather than take one, async-engine
//      writes keyed on a row the same process already owns/validated).
//   2. Calling a same-file helper listed in SCOPED_HELPERS below, whose own
//      body performs the userId filtering on the method's behalf (jobs.ts's
//      `buildFilterConditions`). This escape hatch is self-verifying: the
//      first test in this file asserts each such helper's own body still
//      contains `userId` — if that regresses, THAT assertion goes red, so
//      the allowlist can't rot silently.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPOS_DIR = join(process.cwd(), "src/server/persistence/repos");

const SCOPED_HELPERS: Record<string, string[]> = {
  "jobs.ts": ["buildFilterConditions"],
};

const QUERY_RE = /\.(select|update|delete)\(/;
const WHERE_RE = /\.where\(/;
const GLOBAL_DECISION_RE = /GLOBAL-BY-DECISION/;
const USERID_RE = /userId/;

function repoFiles(): string[] {
  return readdirSync(REPOS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

// `//` line comments in this codebase's prose freely use commas and
// unbalanced-looking parens ("(Fable design review, same class as jobs.ts's
// / listScored):" spans two comment lines) — bracket/comma tracking must
// skip comment content entirely rather than count punctuation inside it. If
// `i` starts a `//` comment, returns the index of the next newline (or
// source.length); otherwise returns `i` unchanged.
function skipLineComment(source: string, i: number): number {
  if (source[i] === "/" && source[i + 1] === "/") {
    const nl = source.indexOf("\n", i);
    return nl === -1 ? source.length : nl;
  }
  return i;
}

// Scans forward from `openBraceIndex` (which must point at a `{`) tracking
// bracket depth across `{}`, `()`, and `[]` uniformly — a method's own body
// can legitimately contain any of these (type-literal params, `sql` tagged
// templates with `${...}` expressions, array types) and a single unified
// counter correctly finds the matching close for well-formed TypeScript
// without needing to special-case which bracket kind is "real". Returns the
// index one past the matching close.
function scanBalanced(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    const skipped = skipLineComment(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced brackets scanning from index ${openBraceIndex}`);
}

// Extracts the text inside the `return { ... }` object literal of
// `createXRepo(db)` — the repo's method table. Every repos/*.ts file with a
// factory has exactly one top-level `return {` (verified empirically: any
// OTHER `return {...}` in these files is a nested return inside a method
// body, which appears strictly later in the file, so the first match is
// always the factory's own).
function extractReturnObjectBody(source: string): string | null {
  const idx = source.indexOf("return {");
  if (idx === -1) return null;
  const braceStart = idx + "return ".length;
  const end = scanBalanced(source, braceStart);
  return source.slice(braceStart + 1, end - 1);
}

// Splits the object-literal body into its top-level entries (one per
// method) by only splitting on a comma at bracket-depth 0 — a naive
// `.split(",")` would also split inside multi-param signatures, type
// literals, and `sql` template expressions.
function splitTopLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const skipped = skipLineComment(body, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim()) entries.push(tail);
  return entries;
}

type MethodEntry = { name: string; text: string };

const METHOD_NAME_RE = /(?:^|\n)\s*(?:\/\/[^\n]*\n\s*)*async\s+(\w+)\s*\(/;

function parseMethods(body: string): MethodEntry[] {
  const methods: MethodEntry[] = [];
  for (const entry of splitTopLevelEntries(body)) {
    const match = METHOD_NAME_RE.exec(entry);
    if (match) methods.push({ name: match[1], text: entry });
  }
  return methods;
}

function extractFunctionBody(source: string, functionName: string): string {
  const sigRe = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)[^{]*\\{`);
  const m = sigRe.exec(source);
  if (!m) throw new Error(`no \`function ${functionName}(...)\` definition found`);
  const braceStart = m.index + m[0].length - 1; // index of the "{"
  const end = scanBalanced(source, braceStart);
  return source.slice(braceStart + 1, end - 1);
}

describe("scoping-audit: every repo query method is userId-scoped or explicitly allowlisted", () => {
  it("SCOPED_HELPERS entries actually scope by userId (closes the helper escape hatch)", () => {
    for (const [file, helperNames] of Object.entries(SCOPED_HELPERS)) {
      const source = readFileSync(join(REPOS_DIR, file), "utf-8");
      for (const helperName of helperNames) {
        const helperBody = extractFunctionBody(source, helperName);
        expect(
          USERID_RE.test(helperBody),
          `${file}: SCOPED_HELPERS lists "${helperName}" but its body no longer references userId — ` +
            `restore the userId filter or remove it from the allowlist (and fix its callers).`,
        ).toBe(true);
      }
    }
  });

  for (const file of repoFiles()) {
    it(`${file}: every filtered query method is userId-scoped or allowlisted`, () => {
      const source = readFileSync(join(REPOS_DIR, file), "utf-8");
      const body = extractReturnObjectBody(source);
      if (body === null) return; // no repo factory in this file (cursor.ts, db.ts) — nothing to audit

      const helperNames = SCOPED_HELPERS[file] ?? [];
      const violations: string[] = [];

      for (const method of parseMethods(body)) {
        if (!QUERY_RE.test(method.text)) continue; // not a select/update/delete — e.g. a plain insert
        if (!WHERE_RE.test(method.text)) continue; // no filter at all — nothing to scope

        const scoped =
          USERID_RE.test(method.text) ||
          GLOBAL_DECISION_RE.test(method.text) ||
          helperNames.some((h) => method.text.includes(`${h}(`));

        if (!scoped) violations.push(method.name);
      }

      expect(
        violations,
        `${file}: method(s) [${violations.join(", ")}] run a filtered query with neither a userId ` +
          `filter nor a // GLOBAL-BY-DECISION comment — this is an unscoped cross-tenant read/write.`,
      ).toEqual([]);
    });
  }
});
