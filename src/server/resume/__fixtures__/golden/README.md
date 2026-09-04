# Golden résumé fixtures (résumé-extraction eval harness v0)

Each `*.json` in this directory is a golden résumé for `eval.live.test.ts`.
Shape:

```
{
  "id": string,
  "category": "real" | "synthetic",
  "rawText": string,          // fed verbatim to the text-path extraction template
  "expected": {
    "name": string,
    "headline"?: string,
    "location"?: string,
    "certifications": string[],
    "languages": string[],
    "projects": string[],
    "skillsMin"?: number,     // minimum distinct extracted skill count
    "roles": [
      { "company": string, "start"?: "YYYY-MM" | null, "end"?: "YYYY-MM" | null, "isCurrent": boolean }
    ]
  }
}
```

Only label facts the `rawText` genuinely supports — an absent concept is
`[]`, never a fabricated label (fail-loud, no invented ground truth).

## v0 scope: text path only

Every fixture here exercises `resume-extract` (text path). There is no
image-only/vision golden yet — the containment guardrail
(`containmentViolations` in `../eval-metrics.ts`) is text-path-inherent: an
image-only résumé has no `rawText` to fuzzy-contain against. Vision eval is a
follow-up, not in scope for this harness.

## Fixtures

- `mobile-dev-monthly-dates.json`, `credential-suffix-year-only.json` —
  **synthetic**, modelled on the layout and failure shapes of two real résumés
  that seeded this harness. No real person's data lives in this repo: names,
  employers, schools, emails and phone numbers are invented.
  `mobile-dev-monthly-dates` covers full `Month YYYY` ranges plus a name that
  must shorten from the full form in `rawText` to a two-token display name.
  `credential-suffix-year-only` covers a credential suffix in the name line
  ("TAN MEI LING, PMP" → name is `Tan Mei Ling`, `PMP` belongs in
  `certifications`) and year-only dates ("2024- 2026") so every role atom is
  `start: null, end: null` — bare years never produce a `YYYY-MM` atom, which
  is spec-correct per `resume-store.ts`'s `coerceMonth`.

  **Rule: never commit a real person's résumé here.** Real failures get
  reduced to a synthetic fixture that reproduces the failing shape.
- `fresh-grad.json`, `table-heavy.json`, `single-column.json` — **synthetic**,
  authored to exercise coverage gaps (education-only/no-experience,
  scrambled-looking skills table, a plain single-column résumé). Labels are
  kept to robust, model-variation-tolerant facts (unambiguous name, a clearly
  present cert/skill, a clearly quantified bullet) — may need tweaks after
  the first live run.
