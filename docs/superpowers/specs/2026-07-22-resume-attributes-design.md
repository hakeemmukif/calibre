# Resume attributes & non-blocking derivation — design

**Date:** 2026-07-22
**Status:** Approved design, pre-plan
**Owner decisions locked with operator during brainstorm (see §2).**

## 1. Problem

Two related problems:

1. **Ingest hard-fails on underivable fields.** `deriveLocation` and `deriveHeadline` in `src/server/resume/derive-view.ts` throw `ParseFailedError` when their fallback chains come up empty, and `ingest.ts` runs `assertResumeViewDerivable` **before** the DB insert. Result: a successfully analyzed résumé is discarded with HTTP 502 `PARSE_FAILED` because the document didn't state a location. We paid for extraction and threw it away.
2. **No editable attribute layer.** The scan pipeline depends on values that may or may not appear in the document (target role; later salary expectations, location). There is nowhere to see or edit what was derived. Users whose documents lack these values (e.g. fresh graduates with no experience entries) have no path forward.

## 2. Locked decisions

- **Approach A:** the attribute layer extends the existing `profile` table/entity (per-user, one home). Rejected: per-résumé overrides (B), separate `resume_attributes` table (C).
- **Sticky edits:** a field the user has set is never overwritten by extraction. Extraction may refresh only fields it itself seeded (or that are empty).
- **Salary attribute =** expected range: min/max + currency + cadence (monthly/annual). Never extracted from the résumé — user-entered only.
- **"Type of job" attribute =** a target role/track descriptor, seeded from the résumé's headline/experience where possible, asked of the user when absent (fresh-grad case).
- **Prompt UX:** inline "finish setup" card in the résumé flow for scan-critical gaps; the full attribute set is editable on `/profile`.

## 3. Contract changes (`src/types`)

- `Resume.headline: string | null` and `Resume.location: string | null` (both currently required). Nullability is **explicit absence**, not a silent default — consumers must branch on it. `ParseFailedError`/502 remains for genuinely unparseable documents.
- `Profile` gains:
  - `displayLocation: string | null`
  - `targetRole: string | null`
  - `salaryMin: number | null`, `salaryMax: number | null`
  - `salaryCurrency: string | null` (ISO-4217 code)
  - `salaryCadence: 'monthly' | 'annual' | null`
  - `attrProvenance: { displayLocation?: 'resume' | 'user'; targetRole?: 'resume' | 'user'; salary?: 'user' }` — salary is one provenance unit (edited as a block; only ever `'user'`).
- Boundary validation (fail loud, in the Zod schema / PUT handler):
  - if any of `salaryMin`/`salaryMax` is set → `salaryCurrency` and `salaryCadence` required;
  - `salaryMin <= salaryMax` when both set;
  - amounts are positive integers.
- OpenAPI/docs regenerate from the schemas as usual (`contract:check`).

## 4. Persistence

New nullable columns on `profile` (next sequential Drizzle migration): `display_location`, `target_role`, `salary_min`, `salary_max`, `salary_currency`, `salary_cadence`, `attr_provenance` (JSON, default `{}`). Empty provenance means "never touched" — the next ingest may seed. Existing rows need no backfill; the résumé view derives at read time.

## 5. derive-view changes

- `deriveLocation` / `deriveHeadline` keep their fallback chains but return `string | null` instead of throwing.
- `assertResumeViewDerivable` is deleted; `ingest.ts` and `reextract.ts` drop the gate. Ingest saves whatever was analyzed.
- Null-tolerant consumers:
  - `ResumeView` / `TailorPreview` / `ResumeRail`: render an explicit "Add location" / "Add headline" affordance (linking to `/profile`) instead of the value. The résumé view keeps showing **document truth** — it does not substitute profile attributes; profile is the user's target layer, the résumé is the document.
  - `searchRuns` `resumeName`: falls back to the résumé `label` (already the ingest fallback direction).
  - `correlate-metrics` / `eval-metrics`: tolerate null (omit from the concatenated string / telemetry).

## 6. Seeding rules (ingest-time)

On successful ingest, for each seedable attribute:

- **`displayLocation`** ← `deriveLocation` chain; **`targetRole`** ← `deriveHeadline` chain.
- Overwrite the profile field only if its provenance is absent or `'resume'` **and** the new derivation is non-null; then mark provenance `'resume'`.
- Provenance `'user'` → never touched by ingest.
- Salary is never seeded.
- Any `PUT /api/profile` that includes an attribute field marks that field's provenance `'user'`.

## 7. Scan gating

- **Scan-critical: `targetRole` only.** `deriveRoleTargets` (`src/server/search/roleMatch.ts`) precedence becomes: `profile.targetRole` → `store.headline` → `experience[0].title` (the existing chain, with the user's explicit target first). If all are null, the scan fails loud with an actionable error telling the user to set their target role — this is the fresh-grad ask.
- **Location does not gate** — geography matching already uses `profile.baseCountry`, not résumé location.
- **Salary does not gate** — nothing consumes it yet; it is stored for future filtering/display (out of scope here).

## 8. UI

- **`/profile`:** a new "Job targets" card beside `ProfileTargets`, composing existing caliber-ui primitives (`Card`, `Input`, `Select`, `Chip`). Fields: display location, target role, salary min/max + currency + cadence. Each seeded field shows a small provenance hint ("from résumé" / "edited"). Save-on-change PUT, same pattern as `ProfileTargets`.
- **Résumé flow:** after analysis, if any scan-critical attribute is missing (currently just `targetRole`; a missing location gets a non-blocking nudge in the same card), show a "Finish setup" card rendering **only the missing fields**, writing to the same PUT `/api/profile`. Disappears once filled.
- Storybook stories for the new composition and the finish-setup card states.

## 9. Testing

- Unit: derive functions return null (not throw); seeding provenance matrix (absent/`resume`/`user` × derivable/not); `deriveRoleTargets` precedence incl. all-null failure; salary boundary validation.
- Contract: updated Zod schemas pass `contract:check`.
- Integration/e2e: ingest a résumé without location/headline → 200, résumé saved, finish-setup card shown; scan with no role signal anywhere → loud, actionable error.

## 10. Out of scope

- Salary consumed by scoring/filtering.
- Per-résumé attribute sets (rejected Approach B).
- Conflict-resolution UI on re-upload (sticky rule makes it unnecessary).
