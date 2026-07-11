// Connector registry — maps a `sources` row (B1 `sourcesRepo`) to a
// SourceConnector instance, keyed by `source.id` (the natural key:
// 'greenhouse'|'lever'|'ashby'|'jobstreet'|... — schema.ts §1).
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { SourceConnector } from "../connector";
import { createAshbyConnector } from "./ashby";
import { createGreenhouseConnector } from "./greenhouse";
import { createJobstreetConnector } from "./jobstreet";
import { createLeverConnector } from "./lever";

const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
};

export function connectorForSource(source: SourceRow): SourceConnector {
  const factory = FACTORIES[source.id];
  if (!factory) throw new Error(`No connector registered for source id "${source.id}"`);
  return factory(source);
}
