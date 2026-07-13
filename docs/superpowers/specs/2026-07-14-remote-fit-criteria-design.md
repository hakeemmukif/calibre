# Caliber — Remote-Fit Criteria: Design Spec

Date: 2026-07-14 · Status: **approved** (operator-reviewed section by section)
Extends: `2026-07-12-remote-local-eligibility-design.md` (the eligibility tier system, Profile singleton, feed predicate). This spec adds the user-side preference dials and job-side restriction facts that make the remote-global lens fit the *user's* situation, not just geography.

## 1. Goal

A remote-global job the user sees should be as applyable as a local one. Geography is already gated (eligibility tiers vs `baseCountry`/`relocation`); the remaining restrictions that make a "remote" job un-takeable from Malaysia are **schedule** (foreign-timezone overlap requirements) and **employment structure** (contractor/EOR vs local-entity employment). The system captures the user's tolerance for each as profile dials and extracts the job's stated requirements as facts; provable mismatches are hidden before the user ever sees them.

## 2. Operator decisions (locked)

1. **Undecidable stays visible.** The predecessor contract holds: only *provably* restricted jobs are hidden; postings that state nothing keep the "Eligibility unverified" warn pill. No strict allowlist.
2. **Schedule tolerance is an ordered 3-level scale**: `base-hours` / `flex-evenings` / `any-hours`. Higher tolerance includes lower. Not binary, not a region checklist.
3. **Archetypes are presets, not state.** "Malaysia-only remote / Global remote / Digital nomad / Open to relocate" are preset cards that set the dials; the dials are the only stored truth.
4. **Calendar (working to the employer country's holidays): extract + display only.** No dial in v1 — postings almost never state it, and inferring it from employer country would hide nearly everything for a "no". Revisit only if stated-calendar facts prove common.
5. **Employment structure ships as a dial with a stated-only hard gate.** Stated conflict (contractor-only vs employee-required) → hidden. Unstated — the common case — no effect and **no warn pill**: unlike geography, an unstated structure is a negotiable detail, not an applyability risk.
6. **Capture UX = `/profile` extension** (preset row + dials on ProfileTargets). No onboarding wizard in v1.
7. **Architecture: facts on the job, dials on the profile, composed at feed-read** (the proven eligibility pattern). No per-user stamps, no LLM-judged gating; match-score stays orthogonal to geography/schedule/structure.
8. **The Layer-C liveness fix rides along** (§4): jd-extract facts become required-but-nullable so gpt-oss-120b actually emits them. `job_scores.policyVersion` bumps.
9. **Deep-crawl extraction (following apply links past the first page) is out of scope** — its own future design. The fact schema here is exactly what it would feed; no rework when it lands.
10. Scan stays as-is; evaluation is the gate (operator directive). Sources/connectors untouched.

## 3. Contract changes (`src/types/index.ts` → `docs/architecture/api-contract.md`)

```ts
export const ScheduleFlex   = z.enum(["base-hours", "flex-evenings", "any-hours"]); // ordered
export const EmploymentPref = z.enum(["any", "employee", "local-entity"]);          // employee = local entity OR EOR

export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,        // exists
  scheduleFlex: ScheduleFlex,        // NEW
  employmentPref: EmploymentPref,    // NEW
  updatedAt: z.string().datetime(),
});
```

- **`Job` API shape: zero new fields.** Display rides `Job.tags` (schedule/structure pills pushed in `assembleJob`) and the detail gaps panel (`workCalendar`). The feed predicate runs server-side on new `jobs` columns.
- The api-contract.md three-axis guard paragraph becomes **four-axis**: `Source.persona` = scan routing · `Job.persona` = run provenance · `Job.eligibility` = posting geography vs base country · schedule/structure facts = stated constraints matched against profile dials at read.

**Untouched, deliberately:** `Persona` and everything it flows through, eligibility tier semantics, dedupe keys, the `match-score` template (fit stays orthogonal), tracker entities, PersonaToggle.

## 4. Extraction — jd-extract additions + the Layer-C liveness fix

Live finding (2026-07-13, recorded at `jdFacts.ts:44-56`): gpt-oss-120b reliably omits `.optional()` fields from structured output; only `isJobPosting`/`company` got the required-nullable fix. **Consequence: `hiringScope`/`hiringCountries`/`location`/`remotePolicy` are likely never emitted on live runs — eligibility Layer C is running on parser + priors alone.** This spec's gates depend on JD facts, so the fix is in scope:

- New **emission schema** (responseSchema for *all* jd-extract LLM calls, both the url-check gate and the scanned path): every fact field required-but-nullable, following the exact `JdFactsGateSchema` precedent. The tolerant parse-side `JdFacts` type is unchanged; nulls normalize at the boundary.
- One live 3/3 verification (same bar as the 2026-07-13 fix) that the new fields come back.
- `config/templates/jd-extract.md` gains, under the existing "stated only — do not guess" contract:
  - `tzRequirement: string | null` — verbatim stated requirement ("4h overlap with PST", "EU working hours"). Template also instructs: timezone/overlap requirements go HERE, not in `hiringCountries` — geography and schedule are separate facts.
  - `hiringStructure: "local-entity" | "eor" | "contractor" | null` — cues: "via Deel/EOR", "B2B contract", "our local entity". The only sanctioned inference: an explicitly contract-term role ("12-month contract") ⇒ `contractor`.
  - `workCalendar: string | null` — stated calendar expectations; display-only.
- `job_scores.policyVersion` bumps (schema change ⇒ re-evaluations refresh cleanly).

## 5. Normalization — pure code, never the LLM

New pure resolver beside `resolveEligibility` (`src/server/score/`): `resolveTzBand(statedTz, parsedGeo) → { band, evidence } | null`.

- Curated token table → band:
  - `americas`: PST/PDT/MST/EST/EDT/ET/PT/"US hours"/"North America"/LATAM
  - `emea`: CET/CEST/GMT/BST/UTC/"EU hours"/EMEA
  - `apac`: SGT/MYT/AEST/JST/"APAC hours"
- Band → minimum dial, **relative to `baseCountry` (MY-only at launch**, same honest extension point as `REGIONS_INCLUDING_MY`): `apac → base-hours` · `emea → flex-evenings` · `americas → any-hours`.
- **`"CST"` is ambiguous** (US Central vs China Standard) → `null` + log. Unmapped token → `null` + log (curated-map drift signal, mirrors `eligibility.ts:86`). **No branch guesses a band**; a job with no band is never hidden by the schedule gate.
- Overlap-hour arithmetic ("4h with PST") deliberately dropped — bands are coarse; refine in v2 only if logs demand it.
- Fact precedence, eligibility-style: JD `tzRequirement` (authority) → Layer-B location-string tokens ("Remote (EST hours)") at ingest.
- `hiringStructure` needs no normalization — the enum is emitted directly, stated-only.

## 6. Persistence & write points

- **`jobs` gains two nullable columns** (enum-checked): `tz_band` (`apac|emea|americas`) and `hiring_structure` (`local-entity|eor|contractor`). `NULL` = nothing stated. Migration adds columns as NULL — no backfill invented.
- **Profile migration seeds `scheduleFlex: "any-hours"`, `employmentPref: "any"`** — the feed is byte-identical before/after until a dial is touched. No runtime defaults; missing row still throws `ProfileMissingError`.
- Write points, identical to eligibility's: ingest stamps what Layer B can parse; the scoring path's jd-extract refresh is authoritative and updates both columns; the pure recompute script extends to re-derive `tz_band` from stored `jd_facts` (also migrating old rows whose TZ terms landed in `hiringCountries`), zero LLM cost.
- **Scan hardening rider:** postings provably outside the dials (e.g. `americas` vs `base-hours`) lose their top-30 scoring slots — persisted, unscored, exactly like `abroad` under `stay`.

## 7. Feed behaviour

Server-side predicate composes three gates per request (dial flips re-scope instantly, zero restamps):

| Gate | Hides when | Passes when |
|---|---|---|
| Geography (exists) | `abroad` under `stay` | per predecessor spec |
| Schedule (new) | `tz_band` demands more than `scheduleFlex` | `tz_band IS NULL` or within tolerance |
| Structure (new) | stated `hiring_structure` conflicts with `employmentPref` (`employee` admits `local-entity`+`eor`; `local-entity` admits only `local-entity`) | `NULL` or compatible |

- `stats.excluded` counts all three gates; strip message generalizes to "N excluded — outside your remote preferences".
- Row pills (existing Tag pattern, no new primitives): schedule pill "US hours"/"EU hours" when a band is known (`apac` suppressed — business-as-usual from MY, same logic as suppressing "Malaysia" on local rows; tooltip = verbatim stated requirement); structure pill "Contractor"/"EOR"/"Local entity" only when stated. `workCalendar` renders in the detail gaps panel when stated.
- Pasted-scope exemption carries over: pasted jobs stay exempt from visibility predicates in their own scope.

## 8. Profile page (`/profile`)

ProfileTargets card grows, existing primitives only, save-on-change `PUT /api/profile` (existing pattern):

- **Preset row on top — "Which sounds like you?"** Four cards that set the dials (not stored; dials remain the only truth):
  - *Malaysia-only remote*: `stay · base-hours · local-entity`
  - *Global remote*: `stay · flex-evenings · any`
  - *Digital nomad*: `stay · any-hours · any`
  - *Open to relocate*: `open · flex-evenings · any`
- **Three segmented controls below**: relocation (exists), schedule (3 levels, captioned in user terms: "Malaysia hours" / "Evenings OK — Europe overlap" / "Any hours — US overlap"), employment ("Any arrangement" / "Employee — EOR OK" / "Malaysian entity only").
- A future onboarding wizard reuses these controls verbatim; none is built now.

## 9. Fail-loud rules (additions to the predecessor inventory)

1. No gate hides on a guess: schedule gate needs a mapped band, structure gate needs a stated enum — both from stated facts only.
2. Unmapped/ambiguous TZ tokens (incl. bare "CST") → `null` + log; never a band.
3. Profile new fields are required in Zod — no runtime defaults; the seed/migration provides initial values once.
4. The emission-schema fix must be live-verified (3/3) before the gates are trusted; until then the feature is dark by construction (seed = permissive).
5. LLM extracts stated facts only; the single sanctioned inference is contract-term role ⇒ `contractor`.

## 10. Testing

- **Unit**: TZ token table (incl. CST ambiguity, unmapped-logs); band→dial mapping; gate composition per dial value; preset→dial mappings; recompute migration of TZ-terms-in-`hiringCountries` rows.
- **Repo**: predicate per dial combination; `excluded` count across gates; migration no-op proof (permissive seed ⇒ identical feed).
- **DOM**: preset cards set dials; segmented controls busy/error/retry; pill rendering + `apac`/unstated suppression.
- **Live**: one 3/3 verification that gpt-oss-120b emits the required-nullable facts.
- **E2E**: one journey — flip the schedule dial on `/profile`, a US-hours job leaves the feed, excluded count moves.

## 11. Validation gate

After one real scan + recompute, measure band/structure coverage (the §11-gate pattern from the predecessor). If stated-TZ coverage is near zero, the gates are decorative on real data — that is the evidence that promotes the **deep-crawl extractor** (apply-form pages carry the sharpest restriction signals, e.g. literal work-authorization questions) to the next design. Numbers decide, not optimism.

## 12. Doc ripple (same change-set as the code)

- `docs/architecture/api-contract.md`: Profile fields, four-axis paragraph, ScheduleFlex/EmploymentPref enums.
- `docs/architecture/system-architecture.md`: jobs columns, resolveTzBand, three-gate predicate, emission schema note.
- `docs/architecture/component-inventory.md`: ProfileTargets preset row + new controls.
- No §11.8 chip changes.

## 13. Out of scope (explicit)

Deep-crawl/multi-layer extraction (separate design); calendar dial; overlap-hour arithmetic; feed re-ranking; visa-sponsorship detection (stays out per predecessor); multi-user auth/onboarding wizard; new connectors; any `match-score` template change.

## 14. Top risks (adversarial pass)

1. **Stated-TZ coverage may be low** → gates decorative. Measured at the §11 gate; deep-crawl is the structural fix. Permissive seed means no harm meanwhile.
2. **Wrong band mapping = false hide** (trust-killer). Curated table + unit tests + logged unmapped tokens; no guess branch exists.
3. **`hiringStructure` hallucination** (model inventing structure from weak cues). Stated-only prompt discipline, one sanctioned inference, spot-check in the live verification.
4. **Emission-schema regression** on the scanned path (schema change touches both callers). Tolerant parse-side type unchanged; live verification + policyVersion bump contain it.
5. **Dial UX misread** ("employee" vs "local-entity" confusion). Captions in user terms on every control; preset cards model the common bundles.
