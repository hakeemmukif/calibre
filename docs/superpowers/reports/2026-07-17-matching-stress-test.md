# Matching stress test — real ATS titles vs `roleFuzzyMatch` (2026-07-17)

Stress test of the de-biased role matcher (`src/server/search/roleMatch.ts`, worktree
`remote-source-matching-fix`) against live postings from the seeded ATS boards. The unit
fixtures pass; this test asks whether the de-bias works on real titles. **Verdict: it does
not — overall labeled recall is 0.425, and every non-engineering function sits between
0.03 and 0.40.** The dominant cause is not the one the fixtures probe (identical title +
short variant) but the real-world posting form the fixtures never contain:
`"<Role>, <Department/Geo/Program>"`.

## 1. Method and sample

- **Harvest**: fetched every seeded slug live (2026-07-17): greenhouse `stripe`,
  `gitlab`, `remote`; lever `toptal`, `GoToGroup`, `shopback-2`; ashby `ramp`, `plaid`,
  `airwallex`, `deel`, `elevenlabs`, `perplexity`, `zapier`, `supabase`, `bjakcareer`.
  2 concurrent per host, 700 ms between waves. **No 403/429 anywhere.**
  - **2,906 postings saved** to `src/server/search/__fixtures__/live-titles.json`
    (worktree), shape `{company, slug, ats, title, location}[]`.
  - **2,399 unique (company, title) pairs** used for all numbers below (Bjak repeats
    each role per country row).
  - Source health: **Deel's ashby board returned an empty `jobs` array** (slug alive,
    zero postings via the posting-api). **Remote's greenhouse board returned only 2
    postings** — likely no longer their primary board. Everything else healthy
    (Stripe 487 unique, Airwallex 514, Bjak 544, ElevenLabs 198, GitLab 160, Ramp 127,
    Plaid 108, Perplexity 80, Supabase 53, ShopBack 46, GoTo 46, Toptal 19, Zapier 16).
    JobStreet (board connector, different API) was not harvested — UNKNOWN here.
- **Battery**: 40 realistic single-résumé role targets across 14 function families
  (each `{titles, keywords}` in the exact shape `deriveRoleTargets` emits /
  `roleFuzzyMatch` consumes), from "Sr. Software Engineer" through "Recruiter",
  "Compliance Officer", "Chief of Staff", "CEO".
- **Oracle**: per-target should-match regexes over the raw title, refined by manual
  inspection of every FP/FN list (two passes). 40 targets × 2,399 titles = 95,960
  scored pairs, of which **2,008 are oracle-labeled should-match**. The oracle is my
  judgment encoded as regexes — its main residual biases are called out in §7.
- **Harness**: throwaway `tsx` scripts in the session scratchpad import the REAL
  `roleFuzzyMatch`; a parametric reimplementation used for rule variants was asserted
  **bit-identical to the real matcher on all 95,960 pairs** (`mismatches = 0`).
  Nothing was added to `src/` except the fixture file.

## 2. Headline result — per-function recall (current matcher)

| function | should-match | recall (current) | recall (recommended §6.1) | FP (current) | FP (rec.) |
|---|---|---|---|---|---|
| engineering | 718 | 0.79 | 0.96 | 165 | 109 |
| data/ML | 140 | 0.34 | 0.91 | 1 | 7 |
| product | 94 | **0.14** | 0.99 | 8 | 8 |
| design | 33 | 0.30 | 0.64 | 0 | 0 |
| marketing | 128 | **0.18** | 0.38 | 3 | 3 |
| sales | 416 | 0.25 | 0.61 | 3 | 4 |
| cs-support | 72 | 0.40 | 0.43 | 0 | 0 |
| finance | 27 | 0.33 | 0.48 | 2 | 2 |
| people/recruiting | 105 | **0.06** | 0.23 | 0 | 0 |
| operations | 100 | 0.20 | 0.65 | 6 | 6 |
| legal/compliance | 62 | 0.21 | 0.27 | 0 | 0 |
| risk | 30 | **0.00**† | 0.10 | 2 | 2 |
| exec (CEO/CoS/VP/CTO) | 18 | **0.11** | 1.00 (small n) | 0 | 0 |
| eng-leadership | 65 | 0.23 | 0.75 | 0 | 0 |
| **total** | **2,008** | **0.425** | **0.722** | **190** | **141** |

† risk recall 0.00: e.g. "Credit Risk Analyst, North American Underwriter" (Stripe)
rejects at J=0.33 for a "Risk Analyst" résumé.

The engineering row is the only one the fixtures represent well. **~55% of the real
inventory across these boards is non-engineering** (see §5) — the de-bias goal — and
that is exactly where recall collapses.

## 3. False-negative taxonomy (current matcher, real titles verbatim)

Root causes ranked by how much labeled recall they cost. Counts are FN rows attributable
to the cause among the 1,154 total FNs (a row can have one primary cause; attribution by
the harness diagnosis note per FN).

### 3.1 Jaccard 0.6 vs the `"<Role>, <Department>"` form — ~500+ FNs, the dominant cause
Review note N2 predicted 1-shared/2-union = 0.5 rejections on tiny sets. Confirmed, and
it is much broader than the predicted 2-token examples: real ATS titles append
department/geo/program qualifiers, so the union grows and Jaccard lands at 0.50–0.25
even when the résumé title is FULLY contained. Verbatim examples (all reject today):
- "Product Manager, Cash Platform" (Stripe) — J=0.50, title contained. **80 of the 94
  labeled product-manager titles fail like this.**
- "Engineering Manager, Data Foundations" (GitLab) — J=0.50, contained.
- "Staff Data Scientist, Growth Analytics" (Airwallex) — J=0.40, contained (27/45 data-scientist titles).
- "Commercial Account Executive - Mid-Market, Canada" (GitLab) — J=0.50 (124+ sales titles).
- "Chief of Staff - AI Neobank App (Singapore)" (Bjak) — J=0.25, contained (all 14 real
  Chief-of-Staff postings reject; N2's exact prediction).
- "Manager, Regulatory Compliance, Vietnam" (Airwallex); "Program Manager, Third Party
  Risk" (Stripe); "Financial Partnerships Manager, International" (Ramp).
- Bjak's country-parenthetical pattern — "Backend Developer (Philippines)" ×23
  countries — is this same cause; most country words are not in `ROLE_STOPWORDS`.

### 3.2 Single-token roles under the same floor — all 47 recruiter titles, 23 CEO-family titles
"Recruiter" vs "Senior Recruiter | Design" (Ramp) → 1/2..1/3 = 0.33–0.50, reject.
"Technical Recruiter" (ElevenLabs) — a LITERAL sub-phrase — rejects at 0.50.
Recruiter recall is **0.00** today.

### 3.3 Baseline-only overlap + engineer/developer variance — ~60 FNs
"Backend Developer" (Bjak, ×23) vs résumé "Backend Engineer": both tokens baseline, no
discriminating overlap possible, and the all-baseline containment shortcut needs every
title token present — "engineer" ≠ "developer". Same family: "Android Software Engineer"
vs "Android Developer", "Brand Designer"/"Visual Designer" vs "Product Designer".

### 3.4 Interposed baseline token defeats containment — ~90 FNs (mobile mostly)
"iOS Software Engineer - AI Neobank App (Austria)" vs "iOS Engineer": the interposed
"Software" breaks both the containment shortcut (not all-baseline title) and Jaccard
(J=0.29). Mobile recall is 0.21 today; 104 of 132 labeled mobile titles fail.

### 3.5 Morphology / synonymy — ~120 FNs, NOT fixed by any threshold
- "Accounting Manager" (Bjak), "Corporate Accounting" (Stripe) vs "Accountant" —
  no shared token at all (accountant ≠ accounting). Accountant recall **0.00**.
- "Talent Acquisition Partner" (Airwallex ×8), "Sr. Technical Sourcer" (Perplexity)
  vs "Recruiter" — zero overlap (synonym).
- "Engineering Lead, Billing" (Airwallex ×10) vs "Engineering Manager" — "lead" is a
  stopword, leaving 1/2 = 0.50.
- "Solutions Architect" (GitLab ×11) vs "Solutions Engineer" — architect/engineer both
  baseline; only "solutions" shared → J=0.33.

### 3.6 Tokenizer notes (small but real)
- "Script and Contentwriter - UK" (Bjak) — compound "contentwriter" never matches "Content Writer".
- "Regulatory Compliance Manager，CN" (Airwallex) — full-width comma handled fine by the
  `[^a-z0-9\s]` strip (verified). No tokenizer crashes on any of the 2,906 titles.

## 4. False positives (current matcher, 190 labeled)

The de-bias itself is NOT leaking across functions at any scale — cross-function FPs are
rare and specific:

1. **All-baseline bag containment is word-order-blind — 55 FPs on one target.**
   "Platform Engineer" (all-baseline {platform, engineer}) matches any title containing
   both words anywhere: "Staff Software Engineer - API Platform" (Stripe), "Full Stack
   Engineer, Web Presence and Platform" (Stripe), even "ML Engineer Manager, AI
   Conversation Platform" (a manager role). Same mechanism lets generalist "Software
   Engineer" résumés match mobile-specialist postings ("iOS Software Engineer", Bjak;
   "Software Engineer II (Android), Financial Platform", Airwallex) — ~55 rows across
   the two SWE targets (judgment call whether those are wrong; I labeled specialist
   mobile roles as non-targets for a generalist backend résumé).
2. **Shared modifier at J=0.67 — ~15 FPs.** "Product Manager" matches "Product
   Marketing Manager" (Stripe/Ramp/Perplexity), "Product Design Manager" (Airwallex):
   {product, manager} ∩ {product, marketing, manager} = 2/3 = 0.67. Likewise
   "Operations Manager" → "Manager, People Operations" / "Senior Manager, IT Operations "
   (Airwallex). Different functions sharing a non-baseline modifier squeak past 0.6 on
   3-token unions. Pre-existing (not introduced by the de-bias), low volume.
3. Keyword tip-over (1 case): marketing keyword "content" pushed "Digital Content
   Manager - UK " (Bjak) over 0.6 for a "Digital Marketing Manager" title.

## 5. Niche coverage of the harvested inventory

- **~55% of unique titles are non-engineering** (approximate first-match classification:
  engineering 866, data/ML 205, sales/GTM 366, marketing 173, ops/admin 138,
  exec/leadership 126, finance 105, product 70, people 47, design 44, cs-support 43,
  legal/compliance 53, risk 20, other 143). A matcher that only works for engineering
  forfeits over half the boards' real inventory.
- **13% (302/2,399) of postings carry "Remote" in their location string.** This
  undercounts remote-relevance: GitLab (160), Zapier (16), Supabase (53), Toptal (19)
  are all-remote employers (seed `geo.scope: "anywhere"`) whose strings are often
  region names; Bjak lists bare country names for remote-across-countries roles.
- SEA-local rows deliver: Bjak alone is 544 unique titles incl. the only real
  Chief-of-Staff and CEO postings in the sample; GoTo/ShopBack add data science,
  finance, legal.

## 6. Tested changes (all numbers measured over the 2,008 labeled pairs)

| variant | recall | FP | Δrecall | ΔFP |
|---|---|---|---|---|
| current (≥1 discr. + J≥0.6 + all-baseline bag containment) | 0.425 | 190 | — | — |
| J≥0.5 | 0.562 | 310 | +0.137 | **+120** |
| J≥0.4 | 0.654 | 429 | +0.229 | **+239** |
| bag containment for ALL titles (+ J≥0.6) | 0.719 | **688** | +0.294 | **+498** |
| phrase containment + head-noun (J≥0.6 kept) | 0.670 | 190 | +0.245 | **±0** |
| phrase + J≥0.5 | 0.702 | 310 | +0.277 | +120 |
| phrase, baseline-containment made phrase-based | 0.663 | 134 | +0.238 | **−56** |
| + head-noun for 2-token titles ("head2") | 0.694 | 286 | +0.269 | +96 |
| **§6.1: phrase w/ baseline-skip + developer→engineer fold** | **0.722** | **141** | **+0.297** | **−49** |

### 6.1 RECOMMENDED: phrase-containment rule set (tested end to end)
Keep the token rule (≥1 discriminating + J≥0.6) exactly as is, and add an OR'd
phrase path; make the existing all-baseline containment use the phrase test instead of
the bag test. Precise spec (implemented and measured in the harness):

1. **Phrase normalization**: lowercase, punctuation→space, drop glue
   `{of, the, and, for, to, a, an, in, at, on, with}` and seniority
   `{senior, sr, junior, jr, principal, lead, intermediate, ii, iii, iv}`; fold
   `developer → engineer` on both sides.
2. **Phrase containment (titles of ≥2 normalized tokens)**: the title's token sequence
   must appear in order in the posting's token sequence, allowing interposed posting
   tokens only if they are `BASELINE_TOKENS` (admits "iOS **Software** Engineer" for
   "iOS Engineer"; still rejects "Product **Marketing** Manager" for "Product Manager"
   because "marketing" is not baseline).
3. **Head-noun match (single-token titles, non-baseline token only)**: take the
   posting's first segment (split on `","`, `"|"`, `"("`, `"/"`, spaced dash), cut any
   `" to …"` tail, and match if the segment's LAST normalized token equals the title
   token. "Recruiter" ⇒ "Senior Recruiter | Design" ✓, "GTM Recruiter, AMER" ✓,
   "CEO, Digital Insurer & Takaful Operator (DITO)" ✓; "CEO Office - …" ✗,
   "Executive Assistant to CEO" ✗, "Recruiting Coordinator" ✗.
4. **All-baseline shortcut**: replace `titleOverlap.length === titleTokens.length` (bag)
   with the rule-2 phrase test.

Measured vs current: **recall 0.425 → 0.722; FP 190 → 141** (fixes 610 FNs, adds 7 FPs,
removes 56 FPs, loses 14 current hits).
- The 7 added FPs, verbatim: "Senior Product Manager, AI Developer Experience"
  (Airwallex — the one genuinely bad add, via developer-fold; a PM role matching an
  ML-engineer résumé), "Member of Technical Staff (AI Software Engineer, Multimodal)" ×2
  (Perplexity, for "AI Engineer" — arguably correct), "Senior Data Platform Engineer,
  Knowledge Platform & AI Enablement" ×3 (Airwallex, for "Data Engineer" — adjacent),
  "Sales Systems Engineer, Enterprise Operations" (Perplexity, for "Sales Engineer").
- The 14 lost hits are the comma-INVERTED baseline forms the bag test caught:
  "Software Engineer, Frontend" (Ramp), "Senior Software Engineer (Frontend), Global
  Payments" (Airwallex ×6), "Backend / API Engineer, Billing" (Stripe), "Staff
  Engineer, Backend, Revenue" (Zapier). If those matter, keep the bag test alongside
  the phrase test for all-baseline titles: that is the `phrase+j0.6` row — recall
  0.670, FP 190 (the 55 word-scatter "…Platform" FPs stay).
- **Fixture consequence (orchestrator decision needed)**: 27/28 existing fixture
  behaviours are preserved, incl. every negative pin (CEO≠CTO, VP Marketing≠VP
  Engineering, Chief of Staff≠Staff Engineer, Manager≠Manager, Engineer II≠Engineer).
  The ONE flip is `"Data Engineer"` vs `"Data Engineer, Kubernetes Platform
  Infrastructure Reliability And Observability Systems"` (pinned false → becomes true).
  The real data says this pin encodes the under-matching itself: the same shape
  ("Product Manager, Global Payouts – Cross-Border & Enterprise Capabilities") is the
  single largest real FN family (§3.1). Recommend flipping that fixture deliberately.

### 6.2 Do NOT just lower the Jaccard floor
J≥0.5 buys +13.7pt recall for +120 FPs, and the new FPs are exactly cross-function
bleed: at 0.5, "People Operations Manager" starts matching 17 non-people rows,
ops-manager adds 22, product-manager 19 (incl. more "Product Marketing Manager" forms),
risk 13. J≥0.4 is worse (+239). The phrase path gets +24.5pt at ±0 FP — thresholds are
the wrong lever because the problem is asymmetric (résumé ⊂ posting), not proximity.

### 6.3 Do NOT extend bag containment to all titles
Recall 0.719 looks competitive but FP explodes to 688: "Chief of Staff" ({staff}) bag-
matches 160 "Staff <X> Engineer" titles, "Head of Finance" ({finance}) matches 66
finance-anything rows, CEO 21, eng-manager 34. This is the trap the current all-baseline
scoping avoids; keep it scoped (or phrase-based per §6.1).

### 6.4 head2 (head-noun for 2-token titles) — not recommended as-is
+2.4pt over §6.1's phrase base but +96 FPs, concentrated where the head noun is not a
function word: "Account Executive" head=executive matches "Digital Marketing Executive"
/ "Finance Executive (Accounts Payable)" (SEA boards use "Executive" as a junior grade);
"VP of Engineering" head=engineering matches "Director of Engineering" and 10 Airwallex
"Engineering Lead, X" rows; "Compliance Officer" head=officer matches "Special Officer".
Only viable with a curated safe-head list — which re-grows the allowlist the de-bias
deleted. Punt.

### 6.5 Remaining gaps after §6.1 (not fixed by anything tested; measured residuals)
- **Synonymy needs vocabulary, not geometry**: Talent Acquisition↔Recruiter (~29 rows),
  Solutions Architect↔Solutions Engineer (36), Engineering Lead↔Engineering Manager (16),
  Accounting↔Accountant (11), Sourcer↔Recruiter. An alias expansion at
  `deriveRoleTargets` (emit synonym titles alongside the résumé's own) would be the
  contract-clean place; untested here beyond the developer→engineer fold.
- **Comma inversion**: "Manager, Regulatory Compliance" for "Compliance Manager";
  the 14 lost hits above. A segment-rotation phrase check is plausible; untested.
- **Altitude**: "Head of Marketing" / "Director, Support" vs a manager-level résumé —
  arguably correct rejections for MVP; my oracle counts some as misses (§7).
- Design 0.64 / marketing 0.38 / people 0.23 / legal 0.27 / risk 0.10 after §6.1 are
  dominated by these synonym/altitude families, not by the threshold.

## 7. Caveats
- The oracle is regex-encoded human judgment (battery + harness in the session
  scratchpad, reproducible from the fixture). Broad-function oracles (marketing:
  any `/marketing/` title; sales-ae: any `\bsales\b`) intentionally count sibling and
  altitude-adjacent roles, so absolute recall for those rows is understated — the
  RELATIVE deltas between variants are the load-bearing numbers.
- Bjak duplicates roles across ~20 country suffixes; families with Bjak examples
  (mobile, CoS, backend-developer) are inflated in row counts but the per-family
  root cause was verified on non-Bjak examples too.
- Battery targets are single-résumé worst cases (one function's titles only). Real
  résumés with 3–4 title variants will do somewhat better than the per-target numbers.
- Sample = 15 boards, 2026-07-17. Deel empty and Remote near-empty (§1); no claim
  beyond these boards. JobStreet unharvested — SEA-board title forms there are UNKNOWN.

## Artifacts
- Fixture: `src/server/search/__fixtures__/live-titles.json` (worktree; 2,906 rows).
- Harness (throwaway, session scratchpad): `harvest.mjs`, `battery.mts`, `run.mts`,
  `fixtures-check.mts` — kept out of `src/`; `src/` untouched apart from the fixture.
