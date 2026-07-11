import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocument } from "./generate";

const API_DIR = join(process.cwd(), "src/app/api");
// Not contract endpoints: the human-facing Scalar docs viewer.
const ALLOWLIST = new Set(["/api/docs"]);

// Walk src/app/api/**/route.ts -> { "/api/jobs/{id}": ["get", ...] }.
function routesOnDisk(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  function walk(dir: string, segments: string[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Next dynamic segment [id] -> {id} to match OpenAPI path templating.
        const seg = entry.startsWith("[") && entry.endsWith("]") ? `{${entry.slice(1, -1)}}` : entry;
        walk(full, [...segments, seg]);
      } else if (entry === "route.ts") {
        const path = `/api/${segments.join("/")}`;
        const src = readFileSync(full, "utf-8");
        const methods = new Set<string>();
        for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
          if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src)) methods.add(m.toLowerCase());
        }
        out.set(path, methods);
      }
    }
  }
  walk(API_DIR, []);
  return out;
}

describe("route <-> contract completeness", () => {
  const doc = buildDocument();
  const disk = routesOnDisk();

  it("every route handler on disk (except the allowlist) is registered in the contract", () => {
    const missing: string[] = [];
    for (const [path, methods] of disk) {
      if (ALLOWLIST.has(path)) continue;
      const contractMethods = doc.paths?.[path] ?? {};
      for (const method of methods) {
        if (!(method in contractMethods)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing, `unregistered routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every contract path+method has a handler on disk", () => {
    const orphans: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of ["get", "post", "patch", "put", "delete"]) {
        if ((item as Record<string, unknown>)[method] && !disk.get(path)?.has(method)) {
          orphans.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(orphans, `contract paths with no handler: ${orphans.join(", ")}`).toEqual([]);
  });
});
