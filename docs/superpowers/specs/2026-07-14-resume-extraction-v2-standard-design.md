# Résumé extraction v2 — a role-agnostic, layout-robust standard

**Date:** 2026-07-14 (rev. 2026-07-15 after Fable adversarial review + scaling decisions)
**Status:** design locked with operator (scope, model, and scaling decisions); code claims verified against source by adversarial review; validated against real résumés with live LLM calls before implementation.

**Reviewers:** Fable design consult (pre-spec) + Fable adversarial review of this document (verified every load-bearing code claim true; verdict "implementable with a Scaling section + point fixes added" — both now folded in below).

## Problem

The current `ResumeStore` extraction is **lossy**, **layout-fragile**, and **blind to image-only PDFs** — and because `ResumeStoreSchema` is the single contract feeding ATS scoring, match-scoring, tailoring, and the apply-assistant, anything it fails to capture is invisible to every one of those engines.

Evidenced by three real résumés the operator supplied:

| Résumé | Failure today |
|---|---|
| **Sample A** (flat skill list, 2-column) | LLM returns `skills` as flat strings → **Zod `invalid_type` error** (the reported crash). When it *doesn't* crash, it coerces to 12 groups with empty `items` → downstream sees **zero skills** (silently broken). |
| **Sample B** (PM/UX, 2-column) | PMP® + 2 Google certs, 4 languages w/ proficiency, and a proper `location` all **lost or mis-bucketed**; name carries a trailing credential ("NAME, PMP"). |
| **Syed** (design-heavy PDF) | **Zero extractable text** — the résumé is an image; `unpdf` returns 0 chars, so no schema can help. |

Root causes:
1. **Schema too rigid + `strict: false`.** `client.ts` sends the JSON schema only as a *hint* (`strict:false`, chosen because our `.optional()` fields 400 under strict). The model ignores the shape and emits its own. gpt-oss-120b is *also* documented (in `jdFacts.ts`) to silently drop `.optional()` fields.
2. **Missing concepts.** No `projects`, `certifications`, `languages`; `education` is `{school,credential,dates}` only; `extras: string[]` is a lossy heading-stripped dump.
3. **Two-column reading-order scramble.** `unpdf` (pdf.js) merges pages without column detection, interleaving sidebars mid-sentence.
4. **No vision path** for image-only PDFs.

## Live validation (before any code)

Real `openai/gpt-oss-120b` on the three résumés with the v2 emit schema below + `strict:true`:

- **Sample A** → parses clean; flat skills round-trip (`label:null`, 12 items); CGPA 3.33 / Dean's List captured. Reproduced the current bug both ways (crash *and* silent-empty).
- **Sample B** → captured PMP® + both Google certs, all 4 languages with proficiency; de-scrambled the location out of interleaved text; stripped the name credential.
- `strict:true` **is** supported on OpenRouter for gpt-oss-120b. Cost ≈ **$0.0003/résumé**, ~400 reasoning tokens at `reasoningEffort: low`.
- v2's larger output **occasionally hits maxTokens=6000** (non-deterministic on dense résumés) → raise to **8000**.
- One prompt bug: with no explicit title line, the model stuffed the summary into `headline` → prompt must define `headline` as a short role line, null if absent.

Vision bake-off on Syed's rasterized page (cheapest reliable wins):

| Model | $/résumé | Verdict |
|---|---|---|
| **mistral-small-3.2-24b-instruct** | **$0.00043** | ✅ chosen — accurate, normalized dates, all projects |
| qwen3.5-flash | $0.00077 | ✅ but un-normalized dates, slow |
| gpt-5-nano | $0.00235 | ✅ most accurate; 5× cost (premium option) |
| gemma-3-27b | $0.00062 | ❌ hallucinated a fake project — rejected |
| gemini-2.5-flash-lite | — | ❌ errored via OpenRouter — revisit later |

## The standard (ResumeStore v2)

Two schemas + one normalizer — the pattern `jdFacts.ts` already proves. The **emit schema** is what makes extraction identical for every role: every field is *required* (so the model must look for all 12 concepts on every résumé), scalars are *nullable* (so "absent" is explicit, not omitted), which in turn unlocks **`strict:true`** constrained decoding.

```ts
// EMIT schema (LLM json_schema, strict:true): every field required.
// Nullable audit (Fable) — a required NON-nullable scalar on a frequently-
// absent concept invites fabrication (this is the class the headline-stuffing
// bug came from). So every scalar that can legitimately be absent is nullable;
// only the person's `name` is required non-null.
ContactLine   { label, value }
Experience    { company, title, dates:null, start:null, end:null, location:null, bullets[] }
Education     { school, credential:null, dates:null, details[] }   // dateless/credential-less entries are common
SkillGroup    { label:null, items[] }                             // label:null = flat list, round-trips honestly
Project       { name, url:null, bullets[] }
Certification { name, issuer:null, year:null }
LanguageEntry { language, proficiency:null }
ExtraSection  { heading, items[] }                                // REPLACES extras[]; keeps the résumé's own heading

ResumeStoreEmit {
  storeVersion,                                                   // = 2; enables targeted re-extraction later (see Scaling)
  name, headline:null, location:null, summary:null,               // summary nullable: summary-less résumés exist
  contact[], experience[], education[], skills[],
  projects[], certifications[], languages[], sections[]
}
```

- **`emitToStore()`** (deterministic): `null → undefined` for scalars, trim, drop empty strings, dedupe skill items, and **coerce `start`/`end` to `"YYYY-MM"` or null — never crash the whole extraction on one malformed date** (availability > fail-loud for a single atom; the miss is logged as telemetry instead). → the DB **store schema**. Then `assertResumeViewDerivable` runs.
- **`start`/`end`** are normalized `"YYYY-MM"` *atoms* the LLM produces cheaply; `dates` keeps the verbatim range for display. **`end: null` is ambiguous** (ongoing vs unparseable) — resolve with an explicit `isCurrent` derived from the verbatim `dates` matching /present|current|now/i, so `currentTenureMonths` is well-defined.
- **`headline`** becomes a real stored field; `derive-view.ts` precedence becomes `store.headline → contact-regex → experience[0].title → education[0]` (see relaxed gate below). `roleMatch.ts` uses `store.headline` first (delete its duplicated regex).
- **Relaxed derivability gate (fresh grads):** `assertResumeViewDerivable` today throws for any résumé with no experience and no title-like contact line — rejecting education-only fresh-grad résumés, a real slice of the SEA niche. v2 adds education/contact fallbacks: derive headline/location from `education[0]` + `contact` when `experience[]` is empty, instead of `ParseFailedError`.
- Same emit schema is shared with the **`tailor`** task (fixes a latent optional-drop bug there); **`tailor` maxTokens raised** too (10000 was sized for the v1 store; v2's store is materially larger).

## Metrics: atoms in, aggregates out (operator chose fields **and** derived signals)

`computeResumeMetrics(store)` — deterministic, no LLM, mirrors `atsScore.ts`, fed by the `start`/`end` atoms:

```
totalYearsExperience (overlap-merged)  currentTenureMonths  roleCount  avgTenureMonths
distinctSkillCount  certificationCount  languageCount  quantifiedBulletRatio
```

`quantifiedBulletRatio` = fraction of experience/project bullets containing a digit or a %/$/currency token (a proxy for "quantified achievement" résumé quality). Defined here because it feeds ATS scoring.

Wired into all three consumers the operator selected:
1. **match-scoring** — pass numeric metrics into the match-score prompt as ground truth (LLM reasons about fit, doesn't miscount years).
2. **ATS/quality score** — fold `quantifiedBulletRatio` + cert/language presence into a richer score.
3. **display** — surface on the résumé page.

**Sequencing note (Fable):** metrics-into-match-score changes scoring behavior in the *same* release as extraction — so "did v2 extraction help?" and "did metrics help scoring?" are entangled. Land the extraction+display first, verify it against the harness, then wire metrics into scoring as a distinct commit so each effect is separately measurable.

Seniority classification stays out (judgment → match-scoring's LLM).

## Layout robustness (prompt-first ladder)

1. Prompt hardening: map sections by meaning; reassemble scrambled fragments; name = person only. **(Validated sufficient for Sample B.)**
2. If a scrambled résumé still fails: raise `resume-extract` reasoning-effort (one-line `models.yml`).
3. Last resort: coordinate-based (x/y) column extraction.

## Vision fallback for image-only PDFs

**Routing threshold (Fable — hybrid PDFs):** the current text gate throws below 20 chars. But a designer résumé with *text headings + an image body* yields ~100–500 chars of junk, passes the gate, and produces confident garbage. Route to vision when extracted text is **below ~400 chars** (well under a real one-page résumé's ~1500+), not merely empty.

When text extraction is below the vision threshold:
1. **Rasterize** page(s) to PNG — `unpdf.renderPageAsImage`, which needs a Node canvas backend → add **`@napi-rs/canvas`** (prebuilt Linux binaries for the Docker deploy). **Page cap:** rasterize at most the first **2 pages** (matches the 2-page input boundary); the $0.00043 figure is single-page, and an un-capped scan is unbounded vision cost.
2. Call a new task **`resume-extract-vision`** → `mistralai/mistral-small-3.2-24b-instruct`, same v2 emit schema + `strict` (confirm strict actually holds for this model during impl — the bake-off asserted the design, not the flag), image content.
3. Same `emitToStore` → identical `ResumeStore`. Persist an **`extractionPath: "text" | "vision"`** marker; on a vision extraction, **nudge the user to review** ("we read this from an image — please check it"). The résumé owner is a free, perfectly-informed hallucination detector — this is the guardrail against the vision-hallucination class (gemma invented a project in the bake-off).

New `config/models.yml` entries: the `resume-extract-vision` task + a price row for the model.

## Blast radius & migration

`ResumeStoreSchema` is (a) the `resume-extract` responseSchema, (b) **also the `tailor` task responseSchema** (via `TailorResultSchema`), (c) the `resumes.structured` + `tailored_resumes.structured` DB JSON columns, (d) consumed by `atsScore`, `derive-view`, `score/*`, `roleMatch`, `apply-assistant`.

| Module | Change |
|---|---|
| `resume-store.ts` | v2 store schema + `ResumeStoreEmitSchema` + `emitToStore()` |
| `config/templates/resume-extract.md` (+ vision template) | rewrite (section-synonym, de-scramble, headline, name) |
| `config/models.yml` | `maxTokens 8000`; add `resume-extract-vision` task + price |
| `client.ts` | `strict:true` when task opts in; JSON-schema `additionalProperties:false` hardener |
| `ingest.ts` | emit schema + `emitToStore`; vision branch when text empty |
| `pdf-text.ts` / new `rasterize.ts` | expose empties for the vision branch; rasterize pages |
| `derive-view.ts` / `roleMatch.ts` | headline precedence uses `store.headline` |
| `tailor/index.ts` + `merge.ts` + `resume-render.ts` + `tailor.md` | shared emit schema; render new sections; drop `extras` |
| `atsScore.ts` + new `resume-metrics.ts` | derived metrics + richer score |
| `score/*` | feed metrics into match-score prompt (separate commit — see sequencing note) |
| `features/resume/*` + résumé page | **minimal read-only display** of projects/certs/languages (human-verification loop) |
| new language-detect + reject path | English-first MVP: detect non-English résumé text, reject loudly with a clear "not yet supported" message |
| DB migration | **re-extract** existing rows from stored `rawText` against v2 (not an SQL fold) |

**Migration is required** (not additive-optional): no read-site re-parses `structured`, so old rows missing `projects`/`sections` would throw at first `.map()`. **Do it by re-extraction, not an SQL backfill:** old `extras` are heading-stripped strings, so folding them into `ExtraSection{heading, items}` would require *inventing* a heading — a fallback move in a no-fallbacks codebase. Since `resumes.rawText` is stored, re-run v2 extraction over existing rows instead — strictly better, and it dogfoods the versioning strategy (below). Trivial volume (single-operator, app still dark). Run with `DATABASE_URL` inline (dev-DB drift trap).

## Scaling & generalization (how this holds for thousands–millions of unseen résumés)

The core thesis: **you don't enumerate résumé *types* — you normalize every résumé to a small closed set of invariants, with an open tail for everything else.** A "million types" is a million *layouts and wordings*, not a million *concepts*. The design absorbs surface variety structurally: `strict:true` guarantees output shape regardless of input; required-nullable forces the model to interrogate every concept (absence explicit, never a silent drop); map-by-meaning-not-heading absorbs section-naming variety; and **`sections[]` with preserved headings is the open-tail pressure valve — the schema does not grow as variety grows.** Fable confirmed the 12-concept core converges with JSON Resume, HR-XML, Europass, and commercial ATS parsers.

**What the ontology does NOT buy, and how we instrument it:** the design deliberately converts failures from *loud* (crash) to *silent* (quiet quality loss). A system whose dominant failure mode is silent can only be controlled by *measurement*. So Phase 1 ships the instruments:

1. **Eval harness v0 (the keystone).** A vitest suite (behind the live-LLM env flag, CI-triggered on edits to `config/templates/resume-extract*.md`, `resume-store.ts`, `config/models.yml`) over **10–15 labeled golden `ResumeStore` fixtures** (the 3 we have + solicited coverage: fresh-grad, long academic CV, table-heavy Word export, image-only, classic single-column, designer/hybrid). Metrics: **per-concept presence precision/recall** (all certs/languages/projects found?), fuzzy match on bullets, exact match on scalars + date atoms, and a **containment check** — every extracted value must fuzzy-appear in `rawText` (this doubles as the text-path hallucination guardrail). Assert aggregate ≥ committed baseline − ε (threshold, not exact — temp 0.1 isn't fully stable). ~$0.005/run. **Growth rule: every résumé that ever fails in prod joins the set** (replayable, since `rawText` is stored).

2. **`sections[]` heading telemetry + field null-rates.** One log line per extraction. The `sections[]` heading distribution across users *is* the drift radar and the concept-promotion signal (a heading recurring across users → promote it to first-class). A sudden field null-rate jump → a regression or a new layout family.

3. **Versioning stance.** `storeVersion` on every stored row now; **the ontology evolves by re-extraction from stored `rawText`, never by re-collecting résumés.** The v1→v2 migration is the first exercise of this.

4. **Confidence routing is deliberately NOT built** (Fable): LLM self-confidence is poorly calibrated; required-nullable already makes absence explicit, and the human-review loop (read-only display → user correction → new golden labels) is the higher-value substitute and the labeled-data flywheel.

**Honest coverage boundaries (stated, not hidden):**
- **English-first MVP.** All samples are English; Bahasa Malaysia / bilingual CN/EN (near-*head* for the SEA niche) are unvalidated for both gpt-oss extraction and pdf.js CJK text. Non-English résumés are detected and **rejected loudly** ("not yet supported") until the harness proves them. Revisit as the golden set grows.
- **Fresh-grad / education-only** résumés: now *accepted* (relaxed gate), but not yet in the validated sample — first non-English-adjacent addition to the harness.
- **>12k chars** rejected (2-page boundary, prior change). **Vision** capped at 2 pages.
- Quality is validated only where the harness has labels; everything else is "shape-guaranteed, quality-unmeasured" until a labeled sample exists.

## MVP boundary

**In:** v2 schema + emit/store split + `strict:true` + prompt rewrite + maxTokens 8000 (+ tailor) + relaxed derivability gate (fresh grads) + tailor/render ripple + **re-extraction migration** + `computeResumeMetrics` (wired to scoring as a *separate* commit) + vision fallback (mistral-small, path marker + review nudge, 2-page cap, ~400-char routing threshold) + **minimal read-only UI** for new fields + **English-first language detection/rejection** + **eval harness v0** + `sections[]`/null-rate telemetry + `storeVersion`.

**Deferred (YAGNI / evidence-gated):** per-skill proficiency; typed contact enums; awards/publications/volunteer as first-class entities (`sections` holds them with headings); coordinate-based PDF parsing (ladder rung 3); editable (vs read-only) new-field UI; multilingual extraction; dual-model vision agreement; per-field confidence routing; LLM-emitted seniority/domain tags; full P/R telemetry dashboards.

## Verification

TDD per module, gated by the **eval harness** (the anti-overfit control — a growing labeled set, not the 3 design samples). End-to-end: drive extract → scan-jobs on the three sample résumés (two via text, one via vision); update job sources for the roles present (mobile dev, PM/UX) as needed. Note the harness is the real generalization test; the end-to-end run is a smoke check, not the quality gate.
