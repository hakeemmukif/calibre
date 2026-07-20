# Wave 4: New ATS Connectors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five new ATS connectors (Workable, Recruitee, Personio, Pinpoint, Rippling), each reaching companies the existing greenhouse/lever/ashby/jobstreet connectors cannot, plus a conditional SmartRecruiters connector gated on a live hit-rate check — extending source reach post-decoupling (Wave 3), not before.

**Architecture:** Every connector is a pure `src/server/search/connectors/<name>.ts` module exporting `create<Name>Connector(source: SourceRow): SourceConnector`, registered in `connectors/index.ts`'s `FACTORIES` map under `config.connector`. No schema, no API, no UI, no changes to `run.ts`/`connector.ts`/`geo.ts` — this wave only adds connector files, their tests, and index.ts registrations. Each connector mirrors `greenhouse.ts`'s shape (`fetchJson` → map → `yield RawPosting` → `onProgress`), using structured payload fields for `geo` where the vendor exposes them (mirroring `lever.ts`/`ashby.ts`), falling back to the existing `parseLocationGeo(location)` pipeline where it doesn't (mirroring `greenhouse.ts` itself).

**Tech Stack:** TypeScript, Next.js 15 (Node runtime), Vitest, no new prod dependencies (hand-rolled XML parsing for Personio, matching `_html.ts`'s no-library precedent).

## Global Constraints

- **Layering:** UI → `features/*` → `server/*`; only `server/*` touches the DB or the LLM. This wave touches only `src/server/search/connectors/*`.
- **Sequence, don't batch:** build in the order Workable → Recruitee → Personio → Pinpoint → Rippling, one connector fully green + committed before starting the next; SmartRecruiters is a separate conditional task after Rippling (design-spine §5, spec §6 step 4).
- **Live-verify each source's endpoint before building it — a prerequisite gate, not a test** (design-spine §5.1). Every connector below already carries a 2026-07-16 live verification (curl'd during this plan's drafting); re-confirm freshness if building substantially later, since ATS payloads drift.
- **Honest self-identifying UA** — every connector goes through `_http.ts`'s shared `fetchJson`/`fetchText`, which already sets `Mozilla/5.0 (compatible; caliber/1.0)`. Never spoof a real browser UA (mirrors `jobstreet.ts`'s posture).
- **Excerpt-only descriptions, link-out via `applyUrl`** — every description is `htmlToText(...).slice(0, 40_000)`, same cap as the existing four connectors; never mirror a full posting beyond that.
- **GDPR — strip recruiter names/emails parsed from descriptions at parse time; do not persist** (spec §7). Personio's live feed embeds exactly this (a "Your contact" section with a name + `mailto:` link) — see Task 3.
- **Register under `config.connector`, never `source.id`** — every new connector is a per-company row resolved via `connectorForSource`'s `config.connector` key (design-spine §1), the same mechanism already proven for `greenhouse`/`lever`/`ashby`.
- **Getro and Consider are NOT built in this wave** (spec §10, §4.2 Tier 3) — Getro's ToS verbatim forbids scraping; Consider is a technical dead-end (obfuscated bundle, no discoverable endpoint). Company discovery comes from yc-oss/jobhive (Wave 2), not VC-portfolio-board scraping.
- **Types are locked cross-wave contract:** do not modify `connector.ts`'s `RawPosting`/`SourceConnector`/`ProgressEvent` shapes, or `geo.ts`'s `ParsedGeo`/`parseLocationGeo`. Vendor `function`/`department`/`category_code` fields (Workable/Recruitee/Personio all expose one) are deliberately **not** wired into a JobFunction hint — `RawPosting` has no such field, and Wave 1's `classifyFunction(title)` (title-only, already shipped) already classifies these titles correctly from text alone; adding a hint field would be a cross-wave contract change out of this wave's file scope. See Task 7's design note.
- **Tests:** `npx vitest run <path>`. Keep the ~1300+ suite green.
- **Commits:** conventional (`feat(connectors): ...`), one commit per green TDD cycle. No `Co-Authored-By` trailer.

---

## File Structure

- `src/server/search/connectors/workable.ts` (new)
- `src/server/search/connectors/workable.test.ts` (new)
- `src/server/search/connectors/recruitee.ts` (new)
- `src/server/search/connectors/recruitee.test.ts` (new)
- `src/server/search/connectors/personio.ts` (new)
- `src/server/search/connectors/personio.test.ts` (new)
- `src/server/search/connectors/pinpoint.ts` (new)
- `src/server/search/connectors/pinpoint.test.ts` (new)
- `src/server/search/connectors/rippling.ts` (new)
- `src/server/search/connectors/rippling.test.ts` (new)
- `src/server/search/connectors/smartrecruiters.ts` (new, **conditional** — Task 6)
- `src/server/search/connectors/smartrecruiters.test.ts` (new, **conditional** — Task 6)
- `src/server/search/connectors/index.ts` (modified — import + register each factory)

---

### Task 1: Workable connector (build first)

Workable's public widget API is the strongest-footed Tier 2 source (spec §4.2: vendor-documented, no auth, no pagination, ~4,269 slugs already in jobhive). Live-verified 2026-07-16 against three real accounts (`apna`, 111 jobs; `pavago`, large; `nuvei`, 57 jobs incl. "Legal Counsel", "Compliance Officer - North America" — confirming the spec's non-eng breadth claim).

**Files:**
- Create: `src/server/search/connectors/workable.ts`
- Create: `src/server/search/connectors/workable.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow` (`@/server/persistence/repos/sources`), `RawPosting`/`SourceConnector` (`../connector`), `ParsedGeo` (`../geo`), `htmlToText` (`./_html`), `fetchJson` (`./_http`).
- Produces: `createWorkableConnector(source: SourceRow): SourceConnector`; registers `FACTORIES.workable`.

- [ ] **Step 0 (manual, prerequisite gate — not a test): live-verify the endpoint**

Run: `curl -s "https://apply.workable.com/api/v1/widget/accounts/apna?details=true" | head -c 500`
Expected: HTTP 200, a JSON object `{"name":"Apna","description":...,"jobs":[{"title":...,"shortcode":...,"application_url":...,"telecommuting":...,"function":...,"department":...,"locations":[...],"description":...}, ...]}`. **Already confirmed 2026-07-16** — the exact field list below was read from this live response. Re-run before building if this plan is executed substantially later; if the shape has drifted, stop and re-derive the mapping rather than guessing.

- [ ] **Step 1: Write the failing discover() mapping test**

Create `src/server/search/connectors/workable.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createWorkableConnector } from "./workable";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "workable",
    name: "Workable",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "apna" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("workable connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the widget-account fixture payload to RawPosting[] (trimmed REAL shape, curled 2026-07-16 from apply.workable.com/api/v1/widget/accounts/apna?details=true)", async () => {
    const fixture = {
      name: "Apna",
      description: null,
      jobs: [
        {
          title: "Admission Counsellor",
          shortcode: "01B0CB39DD",
          code: "",
          employment_type: "Full-time",
          telecommuting: false,
          department: "Skilling",
          url: "https://apply.workable.com/j/01B0CB39DD",
          shortlink: "https://apply.workable.com/j/01B0CB39DD",
          application_url: "https://apply.workable.com/j/01B0CB39DD/apply",
          published_on: "2026-06-27",
          created_at: "2024-12-19",
          country: "India",
          city: "Bengaluru",
          state: "Karnataka",
          function: "Sales",
          industry: "Internet",
          locations: [{ city: "Bengaluru", country: "India", countryCode: "IN", hidden: false, region: "Karnataka" }],
          description: "<p>About Apna</p><p>India's leading job opportunity platform.</p>",
        },
        {
          title: "Customer Support Manager (Work from Home)",
          shortcode: "C2303D92E5",
          telecommuting: true,
          department: "Operations",
          application_url: "https://apply.workable.com/j/C2303D92E5/apply",
          published_on: "2026-06-02",
          country: "India",
          city: "",
          state: "",
          function: "",
          locations: [{ city: "", country: "India", countryCode: "IN", hidden: false, region: null }],
        },
        { title: "Dropped — no application_url", shortcode: "MISSING1" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createWorkableConnector(source());
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "workable",
        externalId: "01B0CB39DD",
        url: "https://apply.workable.com/j/01B0CB39DD/apply",
        title: "Admission Counsellor",
        company: "apna",
        location: "Bengaluru, Karnataka, India",
        geo: { countryCode: "IN" },
        description: "About Apna India's leading job opportunity platform.",
        postedAt: "2026-06-27T00:00:00.000Z",
      },
      {
        sourceId: "workable",
        externalId: "C2303D92E5",
        url: "https://apply.workable.com/j/C2303D92E5/apply",
        title: "Customer Support Manager (Work from Home)",
        company: "apna",
        location: "India",
        geo: { workMode: "remote", countryCode: "IN" },
        description: undefined,
        postedAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://apply.workable.com/api/v1/widget/accounts/apna?details=true",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createWorkableConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response as a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createWorkableConnector(source());
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 2: Run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/workable.test.ts`
Expected: FAIL — `./workable` module does not exist yet.

- [ ] **Step 3: Implement the connector**

Create `src/server/search/connectors/workable.ts`:

```ts
// Workable connector — CONFIRMED endpoint (spec §4.2 Tier 2 + design-spine §5.2;
// live-verified 2026-07-16 against apna/pavago/nuvei's public widget feeds):
// `GET apply.workable.com/api/v1/widget/accounts/{slug}?details=true` → JSON
// `{name, description, jobs: [...]}`, no auth, no pagination (full list in one
// call). `slug` from the source row's `config.slug`. Build FIRST among the new
// Tier 2 connectors — vendor-documented, ~4,269 slugs already in jobhive.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { htmlToText } from "./_html";
import { fetchJson } from "./_http";

// Full field list live-verified 2026-07-16 (apna, 111 jobs; nuvei, 57 jobs incl.
// "Legal Counsel", "Compliance Officer - North America"): title, shortcode,
// code, employment_type, telecommuting, department, url, shortlink,
// application_url, published_on, created_at, country, city, state, education,
// experience, function, industry, locations[], description (present only with
// ?details=true).
interface WorkableJob {
  title?: string;
  shortcode?: string;
  telecommuting?: boolean;
  application_url?: string;
  published_on?: string;
  city?: string;
  state?: string;
  country?: string;
  locations?: { countryCode?: string }[];
  description?: string;
}

interface WorkableAccount {
  jobs?: WorkableJob[];
}

// Structured geo from confirmed payload fields: telecommuting beats string
// parsing for workMode; locations[0].countryCode is already ISO-2.
function workableGeo(j: WorkableJob): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  if (j.telecommuting === true) geo.workMode = "remote";
  const countryCode = j.locations?.[0]?.countryCode;
  if (countryCode) geo.countryCode = countryCode.toUpperCase();
  return Object.keys(geo).length > 0 ? geo : undefined;
}

function toEpochIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function createWorkableConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`workable: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Workable (${slug})…` });
      const json = (await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, {
        signal: ctx.signal,
        redirect: "error",
      })) as WorkableAccount;

      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of jobs) {
        if (!j.application_url || !j.shortcode) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          externalId: j.shortcode,
          url: j.application_url,
          title: j.title ?? "",
          company: slug,
          location: [j.city, j.state, j.country].filter(Boolean).join(", ") || undefined,
          geo: workableGeo(j),
          description:
            typeof j.description === "string" && j.description.trim().length > 0
              ? htmlToText(j.description).slice(0, 40_000)
              : undefined,
          postedAt: toEpochIso(j.published_on),
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Workable (${slug}) done` });
    },
  };
}
```

- [ ] **Step 4: Run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/workable.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register in FACTORIES**

In `src/server/search/connectors/index.ts`, add the import and the map entry:

```ts
import { createWorkableConnector } from "./workable";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
};
```

- [ ] **Step 6: Run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS (all connector test files, including the new one).

- [ ] **Step 7: Commit**

```
git add src/server/search/connectors/workable.ts src/server/search/connectors/workable.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add Workable connector"
```

---

### Task 2: Recruitee connector

Live-verified 2026-07-16 against `personio.recruitee.com` (the HR-software vendor's own careers site, ironically running on Recruitee) — full real schema captured, confirming `careers_apply_url`, `remote`/`hybrid`/`on_site` booleans, `country_code`, `department`, `category_code`.

**Files:**
- Create: `src/server/search/connectors/recruitee.ts`
- Create: `src/server/search/connectors/recruitee.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow`, `RawPosting`/`SourceConnector`, `ParsedGeo`, `htmlToText`, `fetchJson` (same import set as Task 1).
- Produces: `createRecruiteeConnector(source: SourceRow): SourceConnector`; registers `FACTORIES.recruitee`.

- [ ] **Step 0 (manual, prerequisite gate — not a test): live-verify the endpoint**

Run: `curl -s "https://personio.recruitee.com/api/offers/" | head -c 800`
Expected: HTTP 200, `{"offers":[{"title":...,"careers_url":...,"careers_apply_url":...,"city":...,"country":...,"country_code":...,"department":...,"remote":false,"hybrid":false,"on_site":true,"location":...,"description":"<h3>...","published_at":...,"id":...}]}`. **Already confirmed 2026-07-16.**

- [ ] **Step 1: Write the failing discover() mapping test**

Create `src/server/search/connectors/recruitee.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createRecruiteeConnector } from "./recruitee";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "recruitee",
    name: "Recruitee",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("recruitee connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the offers fixture payload to RawPosting[] (trimmed REAL shape, curled 2026-07-16 from personio.recruitee.com/api/offers/)", async () => {
    const fixture = {
      offers: [
        {
          id: 1968676,
          title: "API Job - Berlin",
          careers_apply_url: "https://acme.recruitee.com/o/api-job-berlin/c/new",
          location: "Berlin, Berlin, Deutschland",
          country_code: "DE",
          department: "Produkt",
          category_code: "accountancy",
          remote: false,
          hybrid: false,
          on_site: true,
          description: "<h3>Stellenangebot</h3><p>Wir suchen eine Person.</p>",
          published_at: "2025-01-02 14:22:42 UTC",
        },
        {
          id: 1968677,
          title: "Remote Support Engineer",
          careers_apply_url: "https://acme.recruitee.com/o/remote-support/c/new",
          location: "Worldwide",
          remote: true,
          published_at: "2025-02-10 09:00:00 UTC",
        },
        { title: "Dropped — no careers_apply_url", id: 999 },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createRecruiteeConnector(source({ config: { slug: "acme" } }));
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "recruitee",
        externalId: "1968676",
        url: "https://acme.recruitee.com/o/api-job-berlin/c/new",
        title: "API Job - Berlin",
        company: "acme",
        location: "Berlin, Berlin, Deutschland",
        geo: { workMode: "onsite", countryCode: "DE" },
        description: "Stellenangebot Wir suchen eine Person.",
        postedAt: "2025-01-02T14:22:42.000Z",
      },
      {
        sourceId: "recruitee",
        externalId: "1968677",
        url: "https://acme.recruitee.com/o/remote-support/c/new",
        title: "Remote Support Engineer",
        company: "acme",
        location: "Worldwide",
        geo: { workMode: "remote" },
        description: undefined,
        postedAt: "2025-02-10T09:00:00.000Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.recruitee.com/api/offers/",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createRecruiteeConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response as a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createRecruiteeConnector(source());
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 2: Run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/recruitee.test.ts`
Expected: FAIL — `./recruitee` module does not exist yet.

- [ ] **Step 3: Implement the connector**

Create `src/server/search/connectors/recruitee.ts`:

```ts
// Recruitee connector — CONFIRMED endpoint (spec §4.2 Tier 2 + design-spine
// §5.3; live-verified 2026-07-16 against personio.recruitee.com's public
// careers-site feed): `GET https://{slug}.recruitee.com/api/offers/` → JSON
// `{offers: [...]}`, no auth, vendor-documented "Careers Site API". `slug`
// from the source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { htmlToText } from "./_html";
import { fetchJson } from "./_http";

// Full field list live-verified 2026-07-16: id, title, careers_url,
// careers_apply_url, city, country, country_code, department, category_code,
// remote, hybrid, on_site, location, description, published_at.
interface RecruiteeOffer {
  id?: number;
  title?: string;
  careers_apply_url?: string;
  location?: string;
  country_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  description?: string;
  published_at?: string;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

// Structured geo from confirmed payload fields: remote/hybrid/on_site booleans
// beat string parsing for workMode; country_code is already ISO-2.
function recruiteeGeo(o: RecruiteeOffer): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  if (o.remote === true) geo.workMode = "remote";
  else if (o.hybrid === true) geo.workMode = "hybrid";
  else if (o.on_site === true) geo.workMode = "onsite";
  if (o.country_code) geo.countryCode = o.country_code.toUpperCase();
  return Object.keys(geo).length > 0 ? geo : undefined;
}

function toEpochIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function createRecruiteeConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`recruitee: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Recruitee (${slug})…` });
      const json = (await fetchJson(`https://${slug}.recruitee.com/api/offers/`, {
        signal: ctx.signal,
        redirect: "error",
      })) as RecruiteeResponse;

      const offers = Array.isArray(json?.offers) ? json.offers : [];
      for (const o of offers) {
        if (!o.careers_apply_url) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          externalId: o.id != null ? String(o.id) : undefined,
          url: o.careers_apply_url,
          title: o.title ?? "",
          company: slug,
          location: o.location || undefined,
          geo: recruiteeGeo(o),
          description:
            typeof o.description === "string" && o.description.trim().length > 0
              ? htmlToText(o.description).slice(0, 40_000)
              : undefined,
          postedAt: toEpochIso(o.published_at),
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Recruitee (${slug}) done` });
    },
  };
}
```

- [ ] **Step 4: Run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/recruitee.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register in FACTORIES**

In `src/server/search/connectors/index.ts`:

```ts
import { createRecruiteeConnector } from "./recruitee";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
  recruitee: createRecruiteeConnector,
};
```

- [ ] **Step 6: Run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/server/search/connectors/recruitee.ts src/server/search/connectors/recruitee.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add Recruitee connector"
```

---

### Task 3: Personio connector (XML, GDPR strip)

Live-verified 2026-07-16 against `1nce.jobs.personio.com` — the ONLY Tier 2 source that returns XML, not JSON, and the ONLY one confirmed live to embed third-party recruiter PII (a name + `mailto:` link) directly inside a job description section. No XML library exists in `package.json` — hand-roll regex extraction, matching `_html.ts`'s existing no-cheerio/no-readability precedent.

**Files:**
- Create: `src/server/search/connectors/personio.ts`
- Create: `src/server/search/connectors/personio.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow`, `RawPosting`/`SourceConnector`, `htmlToText`/`unescapeEntities` (`./_html`), `fetchText` (`./_http`). **No `ParsedGeo` import** — see the design note in Step 3 (no structured geo field exists; relies entirely on the existing `parseLocationGeo(location)` fallback, same as `greenhouse.ts`).
- Produces: `createPersonioConnector(source: SourceRow): SourceConnector`; `parsePersonioXml(xml: string): PersonioPosition[]` (exported for the unit test, mirrors `workable.mjs`'s donor precedent of exporting the parse function); registers `FACTORIES.personio`.

- [ ] **Step 0 (manual, prerequisite gate — not a test): live-verify the endpoint**

Run: `curl -s "https://1nce.jobs.personio.com/xml?language=en" | head -c 1500`
Expected: HTTP 200, `<?xml version="1.0" encoding="UTF-8"?><workzag-jobs><position><id>...</id><office>...</office><department>...</department><name>...</name><createdAt>...</createdAt><jobDescriptions><jobDescription><name>...</name><value><![CDATA[...]]></value></jobDescription>...</jobDescriptions></position>...</workzag-jobs>`. **Already confirmed 2026-07-16** — this run additionally surfaced a `<jobDescription><name>Your contact</name><value><![CDATA[​Vladimir Kaiser<br>In case of additional questions... <a href="mailto:jobs@1nce.com">jobs@1nce.com</a>]]></value></jobDescription>` block: a real, live example of the GDPR PII this connector must strip. Also confirmed: no `<url>` tag anywhere in the feed — job pages resolve at `https://{slug}.jobs.personio.com/job/{id}` (verified 200 via `curl -sIL "https://1nce.jobs.personio.com/job/2600654"`).

- [ ] **Step 1: Write the failing discover() + GDPR-strip test**

Create `src/server/search/connectors/personio.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createPersonioConnector, parsePersonioXml } from "./personio";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "personio",
    name: "Personio",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// Trimmed REAL shape, curled 2026-07-16 from 1nce.jobs.personio.com/xml?language=en
// — the "Your contact" block is the exact live-observed GDPR-PII pattern.
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1001</id>
    <office>Remote Germany</office>
    <department>Sales &amp; Marketing</department>
    <name>Account Manager - Germany</name>
    <createdAt>2026-05-01T09:00:00+00:00</createdAt>
    <jobDescriptions>
        <jobDescription>
            <name>Your mission</name>
            <value><![CDATA[<p>Grow our DACH pipeline.</p>]]></value>
        </jobDescription>
        <jobDescription>
            <name>Your contact</name>
            <value><![CDATA[Jane Doe<br>Questions? <a href="mailto:jane.doe@example.com">jane.doe@example.com</a>]]></value>
        </jobDescription>
    </jobDescriptions>
</position>
<position>
    <id>1002</id>
    <office>Berlin</office>
    <department>Engineering</department>
    <name>Backend Engineer</name>
    <createdAt>2026-04-15T12:00:00+00:00</createdAt>
    <jobDescriptions>
        <jobDescription>
            <name>Your mission</name>
            <value><![CDATA[<p>Build APIs.</p>]]></value>
        </jobDescription>
    </jobDescriptions>
</position>
</workzag-jobs>`;

describe("personio connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the XML feed to RawPosting[], constructing the job URL from slug+id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(FIXTURE_XML, { status: 200 })));

    const connector = createPersonioConnector(source({ config: { slug: "acme" } }));
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "personio",
        externalId: "1001",
        url: "https://acme.jobs.personio.com/job/1001",
        title: "Account Manager - Germany",
        company: "acme",
        location: "Remote Germany",
        description: "Grow our DACH pipeline.",
        postedAt: "2026-05-01T09:00:00.000Z",
      },
      {
        sourceId: "personio",
        externalId: "1002",
        url: "https://acme.jobs.personio.com/job/1002",
        title: "Backend Engineer",
        company: "acme",
        location: "Berlin",
        description: "Build APIs.",
        postedAt: "2026-04-15T12:00:00.000Z",
      },
    ]);
    expect(onProgress).toHaveBeenCalled();
  });

  it("GDPR: drops the recruiter's name+email — a jobDescription entry containing a mailto: link is stripped entirely, not just the email substring", async () => {
    const positions = parsePersonioXml(FIXTURE_XML);
    const first = positions.find((p) => p.id === "1001");
    const assembled = first?.jobDescriptions.join(" ") ?? "";
    expect(assembled).not.toContain("Jane Doe");
    expect(assembled).not.toContain("jane.doe@example.com");
    expect(assembled).toContain("Grow our DACH pipeline");
  });

  it("skips positions missing id or name", async () => {
    const xml = `<workzag-jobs><position><office>X</office><jobDescriptions></jobDescriptions></position></workzag-jobs>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(xml, { status: 200 })));
    const connector = createPersonioConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );
    expect(postings).toEqual([]);
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createPersonioConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });
});
```

- [ ] **Step 2: Run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/personio.test.ts`
Expected: FAIL — `./personio` module does not exist yet.

- [ ] **Step 3: Implement the connector**

Create `src/server/search/connectors/personio.ts`:

```ts
// Personio connector — CONFIRMED endpoint (spec §4.2 Tier 2 + design-spine
// §5.3; live-verified 2026-07-16 against 1nce.jobs.personio.com's public
// syndication feed): `GET https://{slug}.jobs.personio.com/xml?language=en` →
// XML `<workzag-jobs><position>...</position></workzag-jobs>`, no auth,
// vendor-documented syndication feature. No XML library in prod deps (_html.ts
// precedent) — hand-rolled regex extraction, matching that file's approach.
// `slug` from the source row's `config.slug`.
//
// No structured remote flag anywhere in the feed (spec §4.2: "remote is
// embedded in the office string, no boolean flag") — `geo` is deliberately
// left unset here so the downstream parseLocationGeo(location) fallback reads
// "Remote" out of the office string, exactly like greenhouse.ts.
//
// GDPR (spec §7): the live feed embeds a recruiter's name + mailto email
// directly inside a `<jobDescription>` entry (observed: name="Your contact",
// value="<name><br>...<a href=\"mailto:...\">...</a>"). Any jobDescription
// whose value contains a mailto: link is dropped entirely before the
// description is assembled — the section name varies by locale, so filtering
// on the mailto: link (not the section name) is the robust, locale-agnostic
// signal. Do not persist recruiter PII.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import { htmlToText, unescapeEntities } from "./_html";
import { fetchText } from "./_http";

interface PersonioPosition {
  id?: string;
  office?: string;
  name?: string;
  createdAt?: string;
  jobDescriptions: string[]; // pre-extracted <value> HTML fragments, GDPR-scrubbed
}

function extractTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? unescapeEntities(match[1].trim()) : undefined;
}

// Parses Personio's XML syndication feed. Exported for unit tests. Hand-rolled
// (no XML library in prod deps) — regex extraction over each <position>
// block, mirroring _html.ts's precedent for HTML.
export function parsePersonioXml(xml: string): PersonioPosition[] {
  const blocks = xml.match(/<position>[\s\S]*?<\/position>/g) ?? [];
  return blocks.map((block) => {
    const descBlockMatch = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(block);
    const descEntries = descBlockMatch
      ? (descBlockMatch[1].match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) ?? [])
      : [];
    const jobDescriptions = descEntries
      .map((entry) => {
        const valueMatch = /<value>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/value>/.exec(entry);
        return valueMatch ? valueMatch[1] : "";
      })
      .filter((value) => value.length > 0 && !value.includes("mailto:")); // GDPR strip — see file header

    return {
      id: extractTag(block, "id"),
      office: extractTag(block, "office"),
      name: extractTag(block, "name"),
      createdAt: extractTag(block, "createdAt"),
      jobDescriptions,
    };
  });
}

function toEpochIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function createPersonioConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`personio: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Personio (${slug})…` });
      const xml = await fetchText(`https://${slug}.jobs.personio.com/xml?language=en`, { signal: ctx.signal });
      const positions = parsePersonioXml(xml);

      for (const p of positions) {
        if (!p.id || !p.name) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          externalId: p.id,
          url: `https://${slug}.jobs.personio.com/job/${p.id}`,
          title: p.name,
          company: slug,
          location: p.office || undefined,
          description:
            p.jobDescriptions.length > 0 ? htmlToText(p.jobDescriptions.join(" ")).slice(0, 40_000) : undefined,
          postedAt: toEpochIso(p.createdAt),
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Personio (${slug}) done` });
    },
  };
}
```

- [ ] **Step 4: Run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/personio.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register in FACTORIES**

In `src/server/search/connectors/index.ts`:

```ts
import { createPersonioConnector } from "./personio";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
  recruitee: createRecruiteeConnector,
  personio: createPersonioConnector,
};
```

- [ ] **Step 6: Run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/server/search/connectors/personio.ts src/server/search/connectors/personio.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add Personio connector (XML, GDPR PII strip)"
```

---

### Task 4: Pinpoint connector

Live-verified 2026-07-16 against `thoughtmachine.pinpointhq.com` — the cleanest legal footing of any Tier 2 source (spec §4.2: officially documented "Job Postings JSON Endpoint", CORS-open by design). Function-coverage breadth confirmed only on this thin (3-posting) live sample — same caveat the spec names; this connector still ships since the endpoint mechanics are fully confirmed.

**Files:**
- Create: `src/server/search/connectors/pinpoint.ts`
- Create: `src/server/search/connectors/pinpoint.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow`, `RawPosting`/`SourceConnector`, `ParsedGeo`, `htmlToText`, `fetchJson`.
- Produces: `createPinpointConnector(source: SourceRow): SourceConnector`; registers `FACTORIES.pinpoint`.

- [ ] **Step 0 (manual, prerequisite gate — not a test): live-verify the endpoint**

Run: `curl -s "https://thoughtmachine.pinpointhq.com/postings.json" | head -c 800`
Expected: HTTP 200, `{"data":[{"id":"...","title":"...","url":"https://thoughtmachine.pinpointhq.com/en/postings/...","description":"<div>...","location":{"city":null,"name":"London",...},"job":{"department":{"name":"..."}},"workplace_type":"onsite","deadline_at":null,...}]}`. **Already confirmed 2026-07-16** — this run also confirmed: no posted-date field anywhere in the payload (only `deadline_at`, an application deadline); `location.name` carries the city (not `.city`, which was null in every sample).

- [ ] **Step 1: Write the failing discover() mapping test**

Create `src/server/search/connectors/pinpoint.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createPinpointConnector } from "./pinpoint";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "pinpoint",
    name: "Pinpoint",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("pinpoint connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the postings.json fixture payload to RawPosting[] (trimmed REAL shape, curled 2026-07-16 from thoughtmachine.pinpointhq.com/postings.json)", async () => {
    const fixture = {
      data: [
        {
          id: "348371",
          title: "Head of DEI - UK",
          url: "https://acme.pinpointhq.com/en/postings/e6a98db1-2b29-470f-ab49-e795f5949aec",
          description: "<div>We are seeking a Head of DEI to lead our UK efforts.</div>",
          location: { city: null, name: "London" },
          job: { department: { id: "59383", name: "Finance" } },
          workplace_type: "onsite",
        },
        {
          id: "348373",
          title: "Marketing Manager",
          url: "https://acme.pinpointhq.com/en/postings/marketing-manager",
          location: { city: null, name: "Paris" },
          workplace_type: "remote",
        },
        { title: "Dropped — no url", id: "999" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createPinpointConnector(source({ config: { slug: "acme" } }));
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "pinpoint",
        externalId: "348371",
        url: "https://acme.pinpointhq.com/en/postings/e6a98db1-2b29-470f-ab49-e795f5949aec",
        title: "Head of DEI - UK",
        company: "acme",
        location: "London",
        geo: { workMode: "onsite" },
        description: "We are seeking a Head of DEI to lead our UK efforts.",
        postedAt: undefined,
      },
      {
        sourceId: "pinpoint",
        externalId: "348373",
        url: "https://acme.pinpointhq.com/en/postings/marketing-manager",
        title: "Marketing Manager",
        company: "acme",
        location: "Paris",
        geo: { workMode: "remote" },
        description: undefined,
        postedAt: undefined,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.pinpointhq.com/postings.json",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createPinpointConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response as a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createPinpointConnector(source());
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 2: Run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/pinpoint.test.ts`
Expected: FAIL — `./pinpoint` module does not exist yet.

- [ ] **Step 3: Implement the connector**

Create `src/server/search/connectors/pinpoint.ts`:

```ts
// Pinpoint connector — CONFIRMED endpoint (spec §4.2 Tier 2 + design-spine
// §5.3; live-verified 2026-07-16 against thoughtmachine.pinpointhq.com): `GET
// https://{slug}.pinpointhq.com/postings.json` → JSON `{data: [...]}`, no
// auth, vendor-documented "Job Postings JSON Endpoint", CORS-open by design —
// the cleanest legal footing of any Tier 2 source (spec §4.2). Function-
// coverage breadth confirmed only on a thin (3-posting) live sample — see
// spec. `slug` from the source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { htmlToText } from "./_html";
import { fetchJson } from "./_http";

// Full field list live-verified 2026-07-16: id, title, url, path, description,
// location{city,name,province,postal_code,street_address}, job{department{id,
// name},division{id,name}}, workplace_type, employment_type, deadline_at,
// compensation*, benefits, key_responsibilities. No posted-date field — see
// postedAt note below.
interface PinpointPosting {
  id?: string;
  title?: string;
  url?: string;
  description?: string;
  location?: { city?: string | null; name?: string | null };
  workplace_type?: string;
}

interface PinpointResponse {
  data?: PinpointPosting[];
}

// Structured geo from the confirmed workplace_type enum (onsite|remote|hybrid)
// — no country field anywhere in this payload, so countryCode is left to the
// downstream parseLocationGeo(location) fallback.
function pinpointGeo(p: PinpointPosting): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  if (p.workplace_type === "remote") geo.workMode = "remote";
  else if (p.workplace_type === "hybrid") geo.workMode = "hybrid";
  else if (p.workplace_type === "onsite") geo.workMode = "onsite";
  return Object.keys(geo).length > 0 ? geo : undefined;
}

export function createPinpointConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`pinpoint: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Pinpoint (${slug})…` });
      const json = (await fetchJson(`https://${slug}.pinpointhq.com/postings.json`, {
        signal: ctx.signal,
        redirect: "error",
      })) as PinpointResponse;

      const postings = Array.isArray(json?.data) ? json.data : [];
      for (const p of postings) {
        if (!p.url || !p.id) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          externalId: p.id,
          url: p.url,
          title: p.title ?? "",
          company: slug,
          location: p.location?.name || p.location?.city || undefined,
          geo: pinpointGeo(p),
          description:
            typeof p.description === "string" && p.description.trim().length > 0
              ? htmlToText(p.description).slice(0, 40_000)
              : undefined,
          // No posted-date field in the confirmed live payload (only
          // `deadline_at`, an application deadline, not a posted date) —
          // postedAt stays undefined rather than fabricating one.
          postedAt: undefined,
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Pinpoint (${slug}) done` });
    },
  };
}
```

- [ ] **Step 4: Run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/pinpoint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register in FACTORIES**

In `src/server/search/connectors/index.ts`:

```ts
import { createPinpointConnector } from "./pinpoint";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
  recruitee: createRecruiteeConnector,
  personio: createPersonioConnector,
  pinpoint: createPinpointConnector,
};
```

- [ ] **Step 6: Run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/server/search/connectors/pinpoint.ts src/server/search/connectors/pinpoint.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add Pinpoint connector"
```

---

### Task 5: Rippling connector (paginated, N+1 fetchDetail)

Live-verified 2026-07-16 against `ats.rippling.com/api/v2/board/joinroot` (Root Insurance) — confirmed all-function breadth ("Sr. Financial Analyst" under "CFO Org"), confirmed pagination (`page`/`pageSize`/`totalItems`/`totalPages`), and confirmed the N+1 description requirement the spec flags: the list endpoint carries no description at all; the detail endpoint's `description` is an object of named HTML sections, not a single string.

**Files:**
- Create: `src/server/search/connectors/rippling.ts`
- Create: `src/server/search/connectors/rippling.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow`, `RawPosting`/`SourceConnector`, `ParsedGeo`, `htmlToText`, `fetchJson`.
- Produces: `createRipplingConnector(source: SourceRow): SourceConnector` — the only Wave 4 connector implementing `fetchDetail(p: RawPosting): Promise<{ description: string }>` (mirrors `jobstreet.ts`'s search/detail split); registers `FACTORIES.rippling`.

- [ ] **Step 0 (manual, prerequisite gate — not a test): live-verify the endpoint**

Run: `curl -s "https://ats.rippling.com/api/v2/board/joinroot/jobs?page=0&pageSize=5" | head -c 800`
Expected: HTTP 200, `{"items":[{"id":"...","name":"Sr. Financial Analyst","department":{"name":"CFO Org"},"locations":[{"name":"Remote (United States)","country":"United States","countryCode":"US","workplaceType":"REMOTE"}],"url":"https://ats.rippling.com/joinroot/jobs/..."}],"page":0,"pageSize":5,"totalItems":11,"totalPages":3}`. **Already confirmed 2026-07-16.** Detail: `curl -s "https://ats.rippling.com/api/v2/board/joinroot/jobs/{id}"` returns `{"description":{"company":"<meta><p>...","role":"<meta><p>..."},"createdOn":"...",...}` — `description` is an **object of named HTML sections** (observed keys `company`/`role`; other tenants may add more), not a flat string.

- [ ] **Step 1: Write the failing discover() + pagination + fetchDetail tests**

Create `src/server/search/connectors/rippling.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createRipplingConnector } from "./rippling";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "rippling",
    name: "Rippling",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "joinroot" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("rippling connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a single page of items to RawPosting[] (trimmed REAL shape, curled 2026-07-16 from ats.rippling.com/api/v2/board/joinroot/jobs)", async () => {
    const fixture = {
      items: [
        {
          id: "836568ae-5bd5-4727-b543-9b15476abdd4",
          name: "Sr. Financial Analyst",
          department: { name: "CFO Org" },
          locations: [
            { name: "Remote (United States)", country: "United States", countryCode: "US", workplaceType: "REMOTE" },
          ],
          url: "https://ats.rippling.com/joinroot/jobs/836568ae-5bd5-4727-b543-9b15476abdd4",
        },
        { name: "Dropped — no id", url: "https://ats.rippling.com/joinroot/jobs/x" },
      ],
      page: 0,
      pageSize: 100,
      totalItems: 1,
      totalPages: 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createRipplingConnector(source());
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "rippling",
        externalId: "836568ae-5bd5-4727-b543-9b15476abdd4",
        url: "https://ats.rippling.com/joinroot/jobs/836568ae-5bd5-4727-b543-9b15476abdd4",
        title: "Sr. Financial Analyst",
        company: "joinroot",
        location: "Remote (United States)",
        geo: { workMode: "remote", countryCode: "US" },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ats.rippling.com/api/v2/board/joinroot/jobs?page=0&pageSize=100",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("paginates across multiple pages using totalPages", async () => {
    const page0 = { items: [{ id: "a", name: "Job A", url: "https://x/a" }], page: 0, totalPages: 2 };
    const page1 = { items: [{ id: "b", name: "Job B", url: "https://x/b" }], page: 1, totalPages: 2 };
    const fetchMock = vi.fn(async (url: string) => {
      const isPage1 = url.includes("page=1");
      return new Response(JSON.stringify(isPage1 ? page1 : page0), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const connector = createRipplingConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings.map((p) => p.externalId)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchDetail assembles description from the object-of-sections shape and throws if empty", async () => {
    const detailFixture = {
      description: {
        company: "<meta><p>Root was founded to fix car insurance.</p>",
        role: "<p>The Sr. Financial Analyst partners with FP&amp;A leaders.</p>",
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(detailFixture), { status: 200 })));

    const connector = createRipplingConnector(source());
    const result = await connector.fetchDetail!({
      sourceId: "rippling",
      externalId: "836568ae-5bd5-4727-b543-9b15476abdd4",
      url: "https://ats.rippling.com/joinroot/jobs/836568ae-5bd5-4727-b543-9b15476abdd4",
      title: "Sr. Financial Analyst",
      company: "joinroot",
    });

    expect(result.description).toContain("Root was founded to fix car insurance.");
    expect(result.description).toContain("Sr. Financial Analyst partners with FP&A leaders.");
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createRipplingConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });
});
```

- [ ] **Step 2: Run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/rippling.test.ts`
Expected: FAIL — `./rippling` module does not exist yet.

- [ ] **Step 3: Implement the connector**

Create `src/server/search/connectors/rippling.ts`:

```ts
// Rippling connector — CONFIRMED endpoint (spec §4.2 Tier 2 + design-spine
// §5.3; live-verified 2026-07-16 against ats.rippling.com/api/v2/board/
// joinroot): `GET https://ats.rippling.com/api/v2/board/{slug}/jobs?page=
// {n}&pageSize={m}` → JSON `{items:[...], page, pageSize, totalItems,
// totalPages}`, no auth, paginated (0-indexed `page`). Undocumented surface
// (Rippling's official docs point to a gated host) — descriptions require an
// N+1 `/jobs/{id}` call, so discover() leaves `description` unset and
// `fetchDetail` covers it lazily (mirrors jobstreet.ts's search/detail
// split — called by describe.ts's ensureDescription for top-N scoring
// candidates only, never at discover-time fan-out scale). `slug` from the
// source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { htmlToText } from "./_html";
import { fetchJson } from "./_http";

const PAGE_SIZE = 100;

// List-endpoint fields live-verified 2026-07-16 (joinroot, 11 jobs incl. "Sr.
// Financial Analyst" under "CFO Org"): id, name, department{name}, url,
// locations[]{name,country,countryCode,workplaceType}. No description field.
interface RipplingJob {
  id?: string;
  name?: string;
  url?: string;
  locations?: { name?: string; countryCode?: string; workplaceType?: string }[];
}

interface RipplingJobsPage {
  items?: RipplingJob[];
  totalPages?: number;
}

// Detail-endpoint `description` is an object of named HTML sections (observed
// {company, role}; other tenants may add more, e.g. requirements/benefits) —
// concatenate every string value rather than hardcode section names.
interface RipplingJobDetail {
  description?: Record<string, unknown>;
}

// Structured geo from the confirmed workplaceType enum (REMOTE|ONSITE|HYBRID,
// uppercase) + countryCode (already ISO-2) on the first location entry.
function ripplingGeo(j: RipplingJob): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  const loc = j.locations?.[0];
  const mode = loc?.workplaceType?.toLowerCase();
  if (mode === "remote" || mode === "onsite" || mode === "hybrid") geo.workMode = mode;
  if (loc?.countryCode) geo.countryCode = loc.countryCode.toUpperCase();
  return Object.keys(geo).length > 0 ? geo : undefined;
}

export function createRipplingConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`rippling: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Rippling (${slug})…` });

      let page = 0;
      let totalPages = 1;
      do {
        const json = (await fetchJson(
          `https://ats.rippling.com/api/v2/board/${slug}/jobs?page=${page}&pageSize=${PAGE_SIZE}`,
          { signal: ctx.signal, redirect: "error" },
        )) as RipplingJobsPage;
        totalPages = json.totalPages ?? 1;

        const jobs = Array.isArray(json.items) ? json.items : [];
        for (const j of jobs) {
          if (!j.url || !j.id) continue;
          const posting: RawPosting = {
            sourceId: source.id,
            externalId: j.id,
            url: j.url,
            title: j.name ?? "",
            company: slug,
            location: j.locations?.[0]?.name || undefined,
            geo: ripplingGeo(j),
          };
          yield posting;
        }

        ctx.onProgress({
          stage: "fetch",
          current: page + 1,
          total: totalPages,
          label: `Rippling (${slug}) page ${page + 1}/${totalPages}`,
        });
        page += 1;
      } while (page < totalPages);
    },
    async fetchDetail(p) {
      if (!p.externalId) throw new Error(`Rippling detail: RawPosting has no externalId: ${p.url}`);
      const detail = (await fetchJson(
        `https://ats.rippling.com/api/v2/board/${slug}/jobs/${p.externalId}`,
      )) as RipplingJobDetail;
      const sections = detail.description && typeof detail.description === "object" ? Object.values(detail.description) : [];
      const html = sections.filter((v): v is string => typeof v === "string").join(" ");
      const description = htmlToText(html).slice(0, 40_000);
      if (!description) throw new Error(`Rippling detail yielded no text: ${p.url}`);
      return { description };
    },
  };
}
```

- [ ] **Step 4: Run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/rippling.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register in FACTORIES**

In `src/server/search/connectors/index.ts`:

```ts
import { createRipplingConnector } from "./rippling";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
  recruitee: createRecruiteeConnector,
  personio: createPersonioConnector,
  pinpoint: createPinpointConnector,
  rippling: createRipplingConnector,
};
```

- [ ] **Step 6: Run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/server/search/connectors/rippling.ts src/server/search/connectors/rippling.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add Rippling connector"
```

---

### Task 6: SmartRecruiters connector — CONDITIONAL on a live hit-rate gate

Design-spine §5 + spec §4.2: SmartRecruiters is downgraded below the other five, ONLY built if a 20–30-slug batch check shows a workable hit rate. The spec's own finding was 5/7 tested slugs returning zero postings. **This task re-confirmed that finding live on 2026-07-16**, batch-testing 10 more well-known-brand slugs: 8 of 10 (`ikea`, `mcdonalds`, `bosch`, `webhelp`, `teleperformance`, `concentrix`, `ing`, `philips`, `siemens`) returned HTTP 200 with `totalFound: 0`; only `visa` returned real postings (2). `robots.txt` was also re-confirmed: `Disallow: /` for everyone except `LinkedInBot`.

**This does not by itself satisfy the gate** — those slugs are enterprises, not the jobhive/yc-oss startup population this program targets, and the gate specifically calls for a 20–30-slug batch drawn from the **actual seeded jobhive SmartRecruiters slugs** (Wave 2 output, not yet vendored at the time this plan was written). Do not build Task 6 until that batch check has been run against real jobhive SmartRecruiters slugs and shows a materially better hit rate than 2/10 zero-adjusted. If the check fails (consistent hit rate near the spec's 5/7-zero finding), **do not build this connector** — mark it explicitly skipped in the commit log and move on; SmartRecruiters adds no value at a near-zero hit rate and carries the worst robots.txt posture of any Tier 2 source.

**Files (only if the gate passes):**
- Create: `src/server/search/connectors/smartrecruiters.ts`
- Create: `src/server/search/connectors/smartrecruiters.test.ts`
- Modify: `src/server/search/connectors/index.ts`

**Interfaces:**
- Consumes: `SourceRow`, `RawPosting`/`SourceConnector`, `ParsedGeo`, `fetchJson`.
- Produces: `createSmartRecruitersConnector(source: SourceRow): SourceConnector`; registers `FACTORIES.smartrecruiters`.

- [ ] **Step 0 (manual, prerequisite gate — decision point, not a test): run the hit-rate batch check**

Pick 20–30 slugs from the Wave 2 jobhive SmartRecruiters CSV (not available until Wave 2 lands). For each slug:

Run: `curl -s "https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=3&offset=0&status=PUBLIC" | python3 -c "import json,sys; print(json.load(sys.stdin).get('totalFound'))"`

Tally slugs with `totalFound > 0` vs `0`. **GO** only if the non-zero rate is materially better than the ~1/7–2/10 rate already observed twice (spec's original 5/7-zero + this plan's 2026-07-16 8/10-zero re-confirmation) — e.g. a majority hit rate. **NO-GO** otherwise: skip this task entirely, do not create `smartrecruiters.ts`, and note the batch result (slugs tested, hit rate) in a one-line commit-free note in the Wave 4 tracking doc.

- [ ] **Step 1 (only if GO): write the failing discover() mapping test**

Create `src/server/search/connectors/smartrecruiters.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createSmartRecruitersConnector } from "./smartrecruiters";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "smartrecruiters",
    name: "SmartRecruiters",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "visa" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("smartrecruiters connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the postings fixture payload to RawPosting[], rewriting ref to a public job URL (trimmed REAL shape, curled 2026-07-16 from api.smartrecruiters.com/v1/companies/visa/postings)", async () => {
    const fixture = {
      offset: 0,
      limit: 3,
      totalFound: 1,
      content: [
        {
          id: "744000133907678",
          name: "Sr. Manager",
          ref: "https://api.smartrecruiters.com/v1/companies/visa/postings/744000133907678",
          releasedDate: "2026-06-24T10:00:11.853Z",
          location: { fullLocation: "Austin, TX, United States", country: "us", remote: false, hybrid: false },
        },
        { name: "Dropped — no id" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createSmartRecruitersConnector(source({ config: { slug: "visa" } }));
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "smartrecruiters",
        externalId: "744000133907678",
        url: "https://jobs.smartrecruiters.com/visa/744000133907678",
        title: "Sr. Manager",
        company: "visa",
        location: "Austin, TX, United States",
        geo: { countryCode: "US" },
        postedAt: "2026-06-24T10:00:11.853Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.smartrecruiters.com/v1/companies/visa/postings?limit=100&offset=0&status=PUBLIC",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createSmartRecruitersConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });
});
```

- [ ] **Step 2 (only if GO): run → confirm FAIL**

Run: `npx vitest run src/server/search/connectors/smartrecruiters.test.ts`
Expected: FAIL — `./smartrecruiters` module does not exist yet.

- [ ] **Step 3 (only if GO): implement the connector**

Create `src/server/search/connectors/smartrecruiters.ts`:

```ts
// SmartRecruiters connector — CONDITIONAL (spec §4.2 Tier 2 downgrade + design-
// spine §5 gate): only built after the live 20-30-slug hit-rate check (Task 6,
// Step 0) passed. `GET api.smartrecruiters.com/v1/companies/{slug}/postings
// ?limit=100&offset=0&status=PUBLIC` works unauthenticated (contra
// SmartRecruiters' own docs) — live-verified 2026-07-16 against
// visa/ikea/mcdonalds/bosch/webhelp/teleperformance/concentrix/ing/philips/
// siemens: 8 of 10 returned `totalFound: 0` (only visa returned postings),
// consistent with the spec's original 5/7-zero finding. `robots.txt` reads
// `Disallow: /` for everyone except `LinkedInBot` (also re-confirmed live) —
// a legal signal none of the other Tier 2 connectors carry. `slug` from the
// source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { fetchJson } from "./_http";

const PAGE_SIZE = 100;

// Fields live-verified 2026-07-16 (visa): id, name, ref, releasedDate,
// location{fullLocation,country,remote,hybrid}. `ref` is an
// api.smartrecruiters.com URL — rewritten below to the public
// jobs.smartrecruiters.com job page. No description field on the list
// endpoint (a full job ad needs a further per-posting call, undocumented and
// out of this connector's confirmed scope) — description stays unset.
interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  ref?: string;
  releasedDate?: string;
  location?: { fullLocation?: string; country?: string; remote?: boolean; hybrid?: boolean };
}

interface SmartRecruitersPage {
  content?: SmartRecruitersPosting[];
}

function toPublicUrl(ref: string | undefined, slug: string, id: string): string | undefined {
  if (!ref || !/\/v1\/companies\/[^/]+\/postings\/[^/?#]+/.test(ref)) return undefined;
  return `https://jobs.smartrecruiters.com/${slug}/${id}`;
}

// Structured geo from confirmed payload fields: remote/hybrid booleans beat
// string parsing; `location.country` is a lowercase ISO-2 code, upper-cased.
function smartRecruitersGeo(p: SmartRecruitersPosting): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  if (p.location?.remote === true) geo.workMode = "remote";
  else if (p.location?.hybrid === true) geo.workMode = "hybrid";
  if (p.location?.country) geo.countryCode = p.location.country.toUpperCase();
  return Object.keys(geo).length > 0 ? geo : undefined;
}

export function createSmartRecruitersConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`smartrecruiters: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning SmartRecruiters (${slug})…` });
      let offset = 0;
      for (;;) {
        const json = (await fetchJson(
          `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}&status=PUBLIC`,
          { signal: ctx.signal, redirect: "error" },
        )) as SmartRecruitersPage;

        const items = Array.isArray(json.content) ? json.content : [];
        for (const p of items) {
          if (!p.id) continue;
          const url = toPublicUrl(p.ref, slug, p.id);
          if (!url) continue;
          const posting: RawPosting = {
            sourceId: source.id,
            externalId: p.id,
            url,
            title: p.name ?? "",
            company: slug,
            location: p.location?.fullLocation || undefined,
            geo: smartRecruitersGeo(p),
            postedAt: p.releasedDate || undefined,
          };
          yield posting;
        }
        if (items.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `SmartRecruiters (${slug}) done` });
    },
  };
}
```

- [ ] **Step 4 (only if GO): run → confirm PASS**

Run: `npx vitest run src/server/search/connectors/smartrecruiters.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5 (only if GO): register in FACTORIES**

In `src/server/search/connectors/index.ts`:

```ts
import { createSmartRecruitersConnector } from "./smartrecruiters";
```

```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector,
  lever: createLeverConnector,
  ashby: createAshbyConnector,
  jobstreet: createJobstreetConnector,
  workable: createWorkableConnector,
  recruitee: createRecruiteeConnector,
  personio: createPersonioConnector,
  pinpoint: createPinpointConnector,
  rippling: createRipplingConnector,
  smartrecruiters: createSmartRecruitersConnector,
};
```

- [ ] **Step 6 (only if GO): run → confirm no regressions**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS.

- [ ] **Step 7 (only if GO): commit**

```
git add src/server/search/connectors/smartrecruiters.ts src/server/search/connectors/smartrecruiters.test.ts src/server/search/connectors/index.ts
git commit -m "feat(connectors): add SmartRecruiters connector (hit-rate gate passed)"
```

---

### Task 7: Full-gate verification + design notes

- [ ] **Step 1: Run the complete connector suite**

Run: `npx vitest run src/server/search/connectors/`
Expected: PASS — all of greenhouse/lever/ashby/jobstreet/fixture/index plus the new workable/recruitee/personio/pinpoint/rippling(/smartrecruiters if built).

- [ ] **Step 2: Run the full project suite to confirm no cross-cutting regressions**

Run: `npx vitest run`
Expected: PASS, ~1300+ tests green (the pre-Wave-4 baseline plus this wave's new tests).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (remember: the commit hook runs `tsc` from the session's main checkout, not a worktree — keep that tree green if this plan is executed in a worktree).

- [ ] **Step 4: Confirm scope closure**

Confirm via `git log --oneline` that Getro and Consider were never touched (no files under any `getro`/`consider` name exist) — per spec §10 they are explicitly not built in this wave; company discovery for all six connectors above comes from the `config.slug` values Wave 2's jobhive/yc-oss pipeline seeds into `sources` rows, never from a VC-portfolio-board scrape.

## Design notes carried out of ambiguity (resolved during drafting, not deferred silently)

- **Vendor `function`/`department`/`category_code` fields are read live in every payload above (Workable's `function`, Recruitee's `category_code`, Personio's `department`/`recruitingCategory`, Pinpoint's `job.department.name`, Rippling's `department.name`, SmartRecruiters' `function.label`) but deliberately NOT wired into `RawPosting`** — that interface has no such field, and Wave 1's `classifyFunction(title)` (title-only, already shipped) already correctly buckets the titles observed live during this plan's verification pass (e.g. Nuvei's "Legal Counsel", "Compliance Officer - North America"; Pinpoint's "Head of DEI - UK", "Marketing Manager"; Rippling's "Sr. Financial Analyst"). Adding a function-hint field to `RawPosting` would be a cross-wave contract change outside this wave's file scope (`connector.ts` is read-only for Wave 4). This wave's connectors match the existing four connectors' behavior exactly: none of them wire department/category info into a structured field either, despite Greenhouse/Lever payloads carrying similar data.
- **`postedAt` is a genuine, permanent gap for two connectors**: Pinpoint's confirmed live payload has no posted-date field at all (only `deadline_at`, an application deadline); Rippling's list endpoint likewise has none (`createdOn` exists only on the per-job detail endpoint, which `fetchDetail`'s return type — `{description: string; applyUrl?: string}` — has no slot to carry back). Both are left `undefined` rather than fabricated, per the no-fallback constraint.
- **Getro and Consider are out of scope for this entire wave** (spec §10, §7) — Getro's Terms verbatim prohibit crawling/scraping/spidering; Consider is a client-rendered, obfuscated bundle with no discoverable endpoint. Neither appears anywhere in the File Structure above.
