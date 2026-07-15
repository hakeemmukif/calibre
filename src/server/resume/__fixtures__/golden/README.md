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

- `sample-a.json`, `sample-b.json` — **real** résumés. `rawText` was extracted
  verbatim (pure text extraction, no LLM) from two real PDFs via a throwaway
  script calling the repo's own `extractPdfText`, then deleted. `expected` is
  labeled from that `rawText` plus documented ground truth from prior live
  extraction runs (see comments in the JSON's originating task spec):
  SampleA's name shortens from the full legal name in `rawText` to "REDACTED_NAME";
  SampleB's dates are all year-only ("2024- 2026" etc.) so every role atom is
  `start: null, end: null` — bare years never produce a `YYYY-MM` atom, this
  is spec-correct per `resume-store.ts`'s `coerceMonth`.
- `fresh-grad.json`, `table-heavy.json`, `single-column.json` — **synthetic**,
  authored to exercise coverage gaps (education-only/no-experience,
  scrambled-looking skills table, a plain single-column résumé). Labels are
  kept to robust, model-variation-tolerant facts (unambiguous name, a clearly
  present cert/skill, a clearly quantified bullet) — may need tweaks after
  the first live run.
