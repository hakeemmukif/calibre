# Caliber — Remote / Malaysia-local Eligibility Hardening: Design Spec

Date: 2026-07-12 · Status: **approved** (operator-reviewed section by section)
Method: Fable panel brainstorm (eligibility model, source organization, settings UX, adversarial critic) over a code-grounded brief; all panel citations verified against the repo.

## 1. Goal

Users have a base country (MY at launch) and a relocation preference. The feed must be pre-filtered so the user never manually sifts out jobs they cannot get:

- **Stay** (not relocating): only Malaysia-local jobs + remote jobs genuinely hireable from Malaysia.
- **Open** (willing to relocate): additionally show roles located elsewhere.
- Fully location-agnostic remote ("work from anywhere") is the best tier.

Sources and algorithms are organized along this axis so eligibility is hardened upstream (ineligible postings stop consuming LLM scan budget), while classification stays auditable. Settings live on a profile page.

## 2. Operator decisions (locked)

1. **Unknown-eligibility jobs under `stay`: shown**, wearing a "Location unverified" warn pill. Never silently eligible, never silently hidden.
2. **`open` reveals everything located elsewhere** — one `abroad` tier folds onsite/hybrid-elsewhere and geo-fenced remote (e.g. "Remote — US only") together.
3. **Region-scoped remote**: APAC / SEA / ASEAN / Asia → eligible from MY. Explicit foreign-timezone-overlap requirements ("4h overlap with PST") → `unknown`.
4. **Coverage**: classifier + profile + feed over the existing 13 sources first; **phase 2** adds one Remotive-class remote-aggregator connector (live-verified before build).
5. **Architecture**: classify-and-store with a deterministic resolver; filter at feed-read; never drop-at-fetch. Zero new LLM calls.
6. **Employer priors confirmed as proposed** (§6 table).
7. **Filter chip**: the persona-based "Remote" chip is replaced by "Work anywhere" (`eligibility = anywhere`). This edits the spec §11.8 chip list (canon change, approved).
8. No feed re-ranking in MVP; sort stays score-based, the pill + chip carry the tier signal.

## 3. Contract changes (`src/types/index.ts` → `docs/architecture/api-contract.md`)

```ts
export const EligibilityTier = z.enum(["anywhere", "eligible", "local", "abroad", "unknown"]);
export const Eligibility = z.object({ tier: EligibilityTier, tone: Tone, summary: z.string() });
// Job gains: eligibility: Eligibility

export const RelocationPref = z.enum(["stay", "open"]);
export const Profile = z.object({
  baseCountry: z.string().length(2), // ISO 3166-1 alpha-2; "MY" at launch
  relocation: RelocationPref,
  updatedAt: z.string().datetime(),
});
```

Tier semantics, relative to `profile.baseCountry`:

| Tier | Meaning | Tone |
|---|---|---|
| `anywhere` | work-from-anywhere remote (best tier) | `verified` |
| `eligible` | remote, hireable from base country (incl. APAC/SEA scoping for MY) | `good` |
| `local` | onsite/hybrid in base country | `good` |
| `abroad` | onsite/hybrid elsewhere OR geo-fenced remote excluding base country | `warn` |
| `unknown` | posting states nothing decidable | `warn` |

- `SummaryStripStats` gains `excluded: z.number().int()` (count hidden by the eligibility predicate).
- New routes: `GET /api/profile` (404 `NOT_FOUND` if unseeded — Resume absence pattern), `PUT /api/profile` (full replace, `Profile.parse`).
- `JobsQuery` (repo layer): `remote?: boolean` (persona-based) is replaced by `eligibility?: EligibilityTier[]`.
- **Three-axis definitions paragraph added to api-contract.md** (load-bearing guard against conflation): `Source.persona` = scan routing · `Job.persona` = run provenance (immutable) · `Job.eligibility` = posting geography relative to profile.

**Untouched, deliberately:** `Persona` enum and everything it flows through (`listEnabledByPersona`, `jobs.persona` stamping, `SearchRun`, PersonaToggle), dedupe keys (`secondaryKey` keeps the raw location string), the `match-score` template (fit stays orthogonal to geography), tracker entities.

## 4. Persistence (`src/server/persistence/`)

- **`profile`** — new singleton table (`id` constant `"default"`, `baseCountry`, `relocation`, timestamps). **Seeded** `{ baseCountry: "MY", relocation: "stay" }` in `seed.ts`, same precedent as the 13 seeded sources: the seed is the install step. Runtime never defaults — a missing row throws `ProfileMissingError`.
- **`jobs`** — two new columns:
  - `eligibility text NOT NULL` (enum-checked); migration backfills existing rows to `'unknown'` (honest: they were never classified).
  - `eligibility_evidence text NOT NULL` — the pill summary (e.g. `"MY board"`, `"JD: hires APAC"`, `"no geography stated"`); migration backfills existing rows to `"predates eligibility classification"`.
  - Geo *facts* get no new columns: connector location already persists in `raw` jsonb, JD-stated facts in `job_scores.jd_facts`. The tier is therefore recomputable by a pure function at any time (backfill script, no LLM cost).
- **`sources`** — no migration. Two new keys in the existing `config` jsonb (§6): `country` on board rows, `geo: { scope, regions? }` on ATS rows. An enabled source missing its annotation throws at connector resolution (same fail-loud as the registry's unknown-connector throw).

## 5. Classification pipeline — three layers, authority-ordered

Resolution precedence: **board country stamp → JD-stated facts → connector-parsed geo → source prior → `unknown`.** Defined once, in one module.

### Layer A — source structure (free, exact)
A posting from a board with `config.country === profile.baseCountry` is `local` by construction (JobStreet: host + `siteKey MY-Main`). JobStreet connector fix rides along: read **all** `locations[].label`, not just `locations[0]`.

### Layer B — deterministic parser (free, scan-time)
New pure module `src/server/search/geo.ts`:

```ts
parseLocationGeo(location: string | undefined): { countryCode?: string; workMode?: "remote"|"hybrid"|"onsite"; regionHint?: string }
```

Curated token tables: MY city list (Kuala Lumpur/KL/Selangor/Penang/Johor Bahru/…), country names, US state abbreviations, region tokens (APAC/SEA/ASEAN/Asia/EMEA/Americas/ANZ/…). No match → `{}` — absent, never fabricated. Connectors fill a new optional `RawPosting.geo` from fields they already read (greenhouse `location.name`, ashby `location`, lever `categories.location`, jobstreet `locations[].label`).

**Before widening any connector interface — four live payload captures** (one curl each) to convert repo-documented unknowns into confirmed reads: Ashby `isRemote`, Lever `country`/`workplaceType`, Greenhouse `offices[]`, JobStreet v5 `locations[]` shape. Only confirmed fields get read.

### Layer C — JD facts + pure resolver (authority, zero new LLM calls)
- `JdFactsSchema` (`src/server/score/jdFacts.ts`) + `config/templates/jd-extract.md` gain `hiringScope?: "anywhere" | "restricted"` and `hiringCountries?: string[]` under the existing "stated only — do not guess" contract (free-text `location`/`remotePolicy` stay).
- New pure resolver `src/server/score/eligibility.ts`:
  - remote + `anywhere` scope → `anywhere`
  - remote + `restricted` → `eligible` iff the static region map includes the base country, else `abroad`. Region map (MVP = MY membership only): APAC/SEA/ASEAN/Asia include MY; US/EU/EMEA/UK/Americas/LATAM/ANZ do not. **Unmapped region term → `unknown` + log line** — never a guess.
  - onsite/hybrid in base country → `local`; elsewhere → `abroad`
  - explicit foreign-TZ-overlap requirement → `unknown`
  - any conflict (e.g. JD says anywhere, connector says New York, precedence can't settle) → `unknown`, conflict noted in `evidence`
  - **No branch defaults to an eligible tier.** The parser/heuristic layer and `restricted` priors may demote, never grant; the single sanctioned lift is an operator-confirmed `anywhere` prior reading a bare "Remote" as `anywhere` (§6).

### Write points & refresh
- Ingest (`upsertMatchedPostings`): Layers A+B stamp `eligibility`/`evidence` at first sight.
- Scoring path (`scoreJob`, already re-runs `jd-extract` per top candidate): resolver re-runs with JD facts and **updates the job row** — the authoritative refresh. `POST /api/jobs/:id/evaluate` inherits this for free.
- Re-sight upsert stays lastSeenAt/aliases-only; parser/resolver improvements reach existing rows via an explicit pure recompute script (no silent drift, no LLM spend).

### Scan hardening
When `relocation = "stay"`, provably-`abroad` postings are excluded from the top-N (30) LLM scoring slots — persisted but unscored, so ineligible jobs stop consuming scan budget. Flipping to `open` makes them visible; on-demand evaluate can score any of them.

## 6. Source organization

`persona` remains the scan-direction selector. Geo annotations (confirmed by operator):

| Source rows | Annotation | Bare-"Remote" reading |
|---|---|---|
| jobstreet | `config.country: "MY"` | n/a — every posting `local` by construction |
| gh-gitlab, gh-remote, ashby-deel, ashby-zapier, ashby-supabase, lever-toptal | `config.geo.scope: "anywhere"` | `anywhere` (all-remote employers) |
| gh-stripe, ashby-ramp, ashby-plaid, ashby-perplexity, ashby-elevenlabs | `config.geo.scope: "restricted"` | `unknown` until the JD proves scope |
| ashby-airwallex | `config.geo.scope: "restricted", regions: ["APAC"]` | leans `eligible` (SG/AU/MY entities) |

Rules: the prior is consulted **only when posting-level evidence is inconclusive**; JD facts always win. Priors are data — correctable in seed/config without code changes. (Known issue rides along: Deel's ashby board is empty upstream and due for a swap; its annotation moves with the replacement.)

**Phase 2 — aggregator connector.** One Remotive-class remote-aggregator board (public JSON API with a per-posting candidate-required-location field) feeding `RawPosting.geo` structurally — direct supply for the `anywhere`/`eligible` tiers the 12 US-leaning ATS boards under-serve. Live API verification before build (unofficial endpoints churn — JobStreet v4 precedent). Explicitly future work: Hiredly/Maukerja/FastJobs (spec §11.3), JobStreet-SG config row.

## 7. Profile page (`/profile`)

- Enable the **existing hidden "Profile & targets" nav row** (`src/app/AppShell.tsx` — id `profile`, Setup section): add to `ENABLED`, `routeFor`, `activeIdFor`. Label stays "Profile & targets".
- New composition `src/caliber-ui/compositions/Profile/ProfileTargets.tsx` — one `Card`, existing primitives only:
  - **Base country**: `Select`, single option "Malaysia" (honest extension point — a new country requires local sources + token tables).
  - **Relocation**: segmented pill mirroring `PersonaToggle` (two filter Chips in a sunken pill): "Stay in Malaysia" ⇄ "Open to relocate".
  - Caption stating the contract in user terms: stay = "Malaysia jobs + remote roles that hire from Malaysia"; open = "also roles abroad".
- Save-on-change `PUT /api/profile`, per-control busy state, inline error + Retry — the `/sources` page interaction pattern. No Save button. No name/avatar fields (scope guard).
- Relocation does **not** change scan fan-out or PersonaToggle — it is only the feed predicate, so flips re-scope instantly with no rescan.

## 8. Feed behaviour

- Server-side predicate from the profile (in `/api/jobs` route → repo `eligibility[]` filter):
  - `stay` → admit `anywhere, eligible, local, unknown`; `abroad` rows persisted but never rendered.
  - `open` → all tiers.
- Summary strip shows the excluded count: "N excluded — not eligible from Malaysia" (`SummaryStripStats.excluded`) — the trust/audit signal for what vanished.
- **`EligibilityTag`** in `src/caliber-ui/lib`, mirroring `LegitimacyTag` (Tag primitive + tone map + label map, `title={summary}`): "Work anywhere" / "Hires from Malaysia" / "Relocation" / "Location unverified". **Suppressed when tier is `local`** (stamping "Malaysia" on every JobStreet row is noise). Rendered beside the legitimacy pill in `JobRow`; also pushed as a `Job.tags` entry in `assembleJob` so the detail page shows it for free.
- Filter chips: "Remote" (persona-based) → **"Work anywhere"** (`eligibility = anywhere`). §11.8 chip list updated accordingly.
- No re-ranking in MVP.

## 9. Fail-loud rules (inventory)

1. Missing `profile` row → `ProfileMissingError`; `startSearch` refuses to run; API returns `NOT_FOUND` envelope.
2. Enabled source missing geo annotation → throw at connector resolution.
3. `assembleJob` throws if a job row lacks `eligibility` (mirrors the legitimacy guard).
4. Resolver: every unresolvable path → `unknown` with an `evidence` string; no eligible-yielding default branch.
5. The parser/heuristic layer and `restricted` priors demote only; the single sanctioned grant is an operator-confirmed `anywhere` prior lifting bare "Remote" to `anywhere` (§6).
6. Unmapped region tokens are logged (curated-map drift signal).
7. LLM extracts stated facts only (existing jd-extract "do not guess" contract, extended verbatim).

## 10. Testing

- **Unit**: `parseLocationGeo` table tests against real shapes ("Remote - US", "Remote — APAC", "Kuala Lumpur", "", "San Francisco / Remote", multi-location JobStreet arrays); resolver precedence/conflict table tests; region-map membership.
- **Repo**: feed predicate per relocation value; `excluded` count; backfill-to-`unknown` migration.
- **DOM**: ProfileTargets (toggle busy/error/retry), EligibilityTag tones/labels/suppression.
- **E2E**: one journey — flip relocation on `/profile`, feed re-scopes and the excluded count moves.
- **Fixtures**: the doubles-mode fixture connector emits `geo` so the hermetic pyramid stays intact.

## 11. Validation gate & phasing

- **Phase 1**: contract + schema/seed + geo parser + jd-extract fields + resolver + feed predicate/strip/pill/chip + profile API/page + tests. (PR slicing decided in the implementation plan.)
- **Gate before phase 2**: one real scan + a ~20-line tier-distribution script. If `unknown` dominates (>~50%), that is the evidence to prioritize the aggregator and tune priors/parser — numbers decide, not optimism.
- **Phase 2**: Remotive-class aggregator connector (live-verified), riding the existing board/connector-factory pattern.

## 12. Doc ripple (same change-set as the code)

- `docs/architecture/api-contract.md`: Profile entity + routes, `Job.eligibility`, `SummaryStripStats.excluded`, `JobsQuery` change, three-axis definitions paragraph.
- `docs/architecture/system-architecture.md`: `profile` table, `jobs` columns, classification step, feed predicate.
- `docs/architecture/component-inventory.md`: ProfileTargets, EligibilityTag.
- `docs/superpowers/specs/2026-07-11-caliber-standalone-design.md` §11.8: chip list edit ("Remote" → "Work anywhere").

## 13. Out of scope (explicit)

No new connectors in phase 1; no visa-sponsorship detection (JD sponsorship language is undecidable noise); no changes to `Persona`, dedupe keys, or the match-score template; no multi-user auth or onboarding flow; no per-source UI tags on the Sources page (server-side config until a later pass); no feed re-ranking.

## 14. Top risks (from the adversarial pass)

1. **False-eligible remote** is the promise-killer — mitigated by: bare "Remote"/empty/unrecognized → `unknown` never eligible; `Source.persona` never feeds eligibility; priors only interpret, never grant on restricted rows.
2. **Silent over-filtering is trust-fatal** — mitigated by classify-and-store, feed-read filtering, visible excluded count.
3. **Unknown-dominant feed** makes the feature decorative — measured at the §11 gate; phase-2 aggregator is the structural fix.
4. **Taxonomy collision** (persona vs eligibility) — mitigated by the three-axis contract paragraph and leaving persona untouched.
5. **Stale classifications** (re-sight upsert doesn't refresh) — mitigated by score-path refresh + explicit recompute script.
