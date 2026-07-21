// Connector registry — maps a `sources` row (B1 `sourcesRepo`) to a
// SourceConnector instance, keyed by `config.connector` (per-company rows,
// e.g. `gh-stripe` → connector "greenhouse"), falling back to `source.id`
// for canonical single-board rows ('jobstreet', and the fixture/test seeds).
import { testDoublesEnabled } from "@/lib/llm/client";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { SourceConnector } from "../connector";
import { parseSourceGeo } from "../geo";
import { createAshbyConnector } from "./ashby";
import { createFixtureConnector } from "./fixture";
import { createGreenhouseConnector } from "./greenhouse";
import { createJobstreetConnector } from "./jobstreet";
import { createLeverConnector } from "./lever";
import { createSmartRecruitersConnector } from "./smartrecruiters";

const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  smartrecruiters: createSmartRecruitersConnector,
};

export function connectorForSource(source: SourceRow): SourceConnector {
  if (testDoublesEnabled()) return createFixtureConnector(source);
  parseSourceGeo(source); // fail loud on a mis-annotated real source before any fetch (spec §9.2)
  const key = (source.config as { connector?: string })?.connector ?? source.id;
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`No connector registered for source id "${source.id}" (connector key "${key}")`);
  return factory(source);
}
