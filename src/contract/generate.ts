// Builds the OpenAPI 3.1 document from `registry` and writes the committed
// contract/openapi.json. Run via `npm run contract`. Fails loud: never
// writes a partial/empty document.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { getDefinitions } from "./registry";

const AUTH_NOTE = "Auth: none in v1 (single-operator; network-layer protection only).";

const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../contract/openapi.json");

export function buildDocument(): OpenAPIObject {
  const definitions = getDefinitions();
  if (definitions.length === 0) {
    throw new Error("contract: registry has no definitions — refusing to generate an empty OpenAPI document");
  }

  const generator = new OpenApiGeneratorV31(definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Caliber API",
      version: "1.0.0",
      description: AUTH_NOTE,
    },
  });

  if (!document.openapi || !document.info || !document.paths || !document.components) {
    throw new Error("contract: generated OpenAPI document is missing required top-level keys");
  }

  return document;
}

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(deepSortKeys(document), null, 2)}\n`;
}

function run() {
  const json = serializeDocument(buildDocument());
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, json);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
