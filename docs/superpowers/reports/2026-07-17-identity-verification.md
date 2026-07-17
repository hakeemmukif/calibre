# Source identity verification — measured mis-attribution rate

**Date:** 2026-07-17
**Module:** `src/server/sources/identity.ts` (+ `identity.test.ts`)
**Question:** before we seed ~1,000 discovered `(ats, slug)` sources, how many actually belong to the company we matched them to?

**Headline: 13.0% of live matched candidates are mis-attributed (15/115). Name-matching is NOT safe to seed unverified. Neither is domain-stem matching — it is measurably WORSE (20% vs 5%).**

---

## 1. What identity signal each vendor actually exposes (verified live 2026-07-17)

The earlier probe concluded that only greenhouse exposes identity, and that lever/ashby would be
"mostly unverifiable". **That conclusion is wrong.** It only inspected the JSON posting APIs. All
three vendors expose a usable identity signal; the probe simply looked in the wrong place for two
of them.

| ATS | Endpoint used | Signal | Probe said | Reality |
|---|---|---|---|---|
| greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}` | `{"name":"Stripe","content":""}` | has identity | **confirmed** |
| lever | `jobs.lever.co/{slug}` (board page) | `<title>Porter Cares, Inc. </title>` | no identity | **wrong — identity IS available** |
| ashby | `jobs.ashbyhq.com/{slug}` (board page) | embedded `"organization":{"name":"0g Labs","publicWebsite":"https://0g.ai/",...}` | no identity | **wrong — identity AND a domain are available** |

Corrections to the probe, in detail:

- **lever** — `api.lever.co/v0/postings/{slug}` genuinely carries no org identity (keys are
  `text, categories, hostedUrl, applyUrl, description, …`). The probe stopped there. The public
  board page `jobs.lever.co/{slug}` puts the org name in its `<title>`, verified against
  `porter` → `Porter Cares, Inc.` and `15five` → `15Five`.
- **ashby** — the posting-api payload's top-level keys really are exactly `jobs, apiVersion`, and
  `jobs.ashbyhq.com/robots.txt` **disallows `/api/`** (so the `non-user-graphql` route is off
  limits and we do not use it). But the board page itself is allowed and embeds a bootstrap JSON
  blob carrying `organization.name` *and* `organization.publicWebsite`. Ashby is therefore our
  **strongest** signal, not our weakest — it is the only vendor that hands us a domain.

**robots / politeness (design §7).** `jobs.lever.co/robots.txt` is `User-agent: * / Allow: /`
(with `Content-Signal: search=yes, ai-train=no, use=reference` — we are a reference use, not
training). `jobs.ashbyhq.com/robots.txt` disallows only `/meeting/`, `/b/`, `/api/`; board pages
are permitted. No 403 or 429 was received from any vendor during the live run, so no vendor stop
was triggered.

**Ashby soft-404s.** `jobs.ashbyhq.com/{unknown-slug}` returns **HTTP 200** with a generic
7128-byte shell (`<title>Jobs</title>`, no `organization` block) rather than a 404. Verified
against a deliberately bogus slug. This is why the module treats a missing org block as
`unverifiable`, never as confirmed — a status check alone would be fooled here.

---

## 2. The API as built

```ts
export type IdentityVerdict =
  | { status: "confirmed"; evidence: string }
  | { status: "mismatch"; evidence: string }
  | { status: "unverifiable"; reason: string };

export async function verifyIdentity(
  candidate: { name; slug; ats; companyDomain; matchMethod },
  opts: { fetch: FetchLike; politenessDelayMs?: number },
): Promise<IdentityVerdict>;
```

- `FetchLike` is **imported** from `./validate`. The per-host semaphore (`createHostLimiter`) is
  **mirrored, not imported** — it is module-private in `validate.ts` and this task must not edit
  that file. It is instantiated module-level at **2 concurrent per host** because `verifyIdentity`
  is per-candidate: callers fan out with `Promise.all`, so a call-scoped limiter would bound
  nothing.
- `unverifiable` never throws and never defaults to confirmed (CLAUDE.md no-fallback rule).
  403/429/404/network errors and absent identity fields all land here with an explicit reason,
  after **exactly one** request — no retry (§7).

### The name-comparison rule

Lowercase → strip diacritics → **split on whitespace and commas ONLY** → drop trailing
legal-entity suffix tokens (`inc, llc, ltd, gmbh, sas, pty, …`) → join → drop remaining
punctuation. Exact equality after that.

**Why it rejects Affinity:** we never split on `.`, so `"Affinity.co"` stays a *single* token.
`co` is therefore never seen as a standalone legal suffix and is not stripped, yielding
`affinityco` ≠ `affinity`. A rule that tokenized on `.` would strip `co` and **confirm the
mis-attribution** — this is precisely the false-positive path the upstream matcher takes.

**Why it still accepts variance:** in `"Stripe, Inc."`, `Inc.` *is* a standalone trailing token,
so it strips to `stripe` == `stripe`.

**Only legal-entity suffixes are stripped — never descriptors** (`Labs`, `Analytics`,
`Technologies`, `Network`, `Cares`). Stripping descriptors is exactly what would let
`Affinity Analytics` and `Porter Cares, Inc.` pass. Likewise **no containment / token-subset
matching**: both looser rules confirm real mis-attributions from our own data
(`Porter Cares` contains `Porter`; `Affinity Analytics` ⊃ `Affinity`).

**Domain evidence outranks name evidence** where ashby supplies `publicWebsite`: a shared
registrable domain is far harder to collide on than a name. A *differing* domain is not treated as
proof of mismatch (one company legitimately runs several domains) — it falls through to the name
rule.

### `matchMethod` is deliberately NOT used to weight the verdict

The brief allowed weighting `domain-stem` as the stronger signal. **The data refutes that
premise** — see §3: domain-stem mismatches at **20%** vs name's **5%**. Short generic stems
(`golf`, `porter`, `apollo`, `solutions`) collide constantly, and `solutions.travel.rakuten.com`
even stems to `solutions`. `matchMethod` describes how the candidate was *generated* (a prior);
the verdict rests on what the vendor *said* (direct evidence). Letting the prior override the
evidence would re-admit exactly the errors this module exists to catch. It is carried in the
evidence string so the operator can slice by it.

---

## 3. Measured rates

Candidates were generated by reproducing upstream matching (yc-oss + remoteintech → jobhive slugs
by domain-stem or normalized name) over the real data in the probe scratchpad:
**1,056 candidates total** (greenhouse 345, lever 168, ashby 543). A deterministic stratified
sample of **120** (20 per `ats` × `matchMethod` cell) was verified live.

```
ALL: n=120  confirmed=99  mismatch=15  unverifiable=6
  greenhouse: n=40  confirmed=30  mismatch=9  unverifiable=1
  lever:      n=40  confirmed=36  mismatch=4  unverifiable=0
  ashby:      n=40  confirmed=33  mismatch=2  unverifiable=5

  domain-stem: n=60  confirmed=47  mismatch=12  unverifiable=1
  name:        n=60  confirmed=52  mismatch=3   unverifiable=5

    greenhouse/domain-stem: n=20  confirmed=14  mismatch=6  unverifiable=0
    greenhouse/name:        n=20  confirmed=16  mismatch=3  unverifiable=1
    lever/domain-stem:      n=20  confirmed=16  mismatch=4  unverifiable=0
    lever/name:             n=20  confirmed=20  mismatch=0  unverifiable=0
    ashby/domain-stem:      n=20  confirmed=17  mismatch=2  unverifiable=1
    ashby/name:             n=20  confirmed=16  mismatch=0  unverifiable=4
```

**`unverifiable` is rare, not the norm the probe predicted — and 5 of the 6 are dead boards.**
Cross-checked against each vendor's listing endpoint (the one `validate.ts` uses):

| Candidate | Reason | Listing endpoint | Verdict |
|---|---|---|---|
| ashby/doe, ashby/cascade, ashby/robot-learning-co, ashby/response | `no_identity_field` | posting-api **404** | dead board — `validate.ts` drops these anyway |
| greenhouse/alma | `not_found` | boards **404** | dead board — dropped anyway |
| **ashby/prometheus** | `no_identity_field` | posting-api **200, 2 jobs** | **live but unattributable** — no hosted board page (embed-only org). Genuine operator/monitor decision. |

**Restated over the 115 candidates whose boards are actually live: 99 confirmed (86.1%),
15 mismatch (13.0%), 1 unverifiable (0.9%).**

---

## 4. Real mis-attributions found (beyond Affinity/Porter)

All 15 mismatches, audited. **10 are confirmed different companies, 2 are probable, 3 are
conservative false mismatches** (the safe direction — we decline to seed rather than mis-attribute).

### Confirmed mis-attributions — must not seed

| Candidate | We expected | Vendor actually says |
|---|---|---|
| `greenhouse/solutions` [domain-stem] | Rakuten Travel Xchange (`solutions.travel.rakuten.com`) | **Cadence Solutions** |
| `greenhouse/golf` [domain-stem] | Golf (`golf.dev`) | **GOLF.com/GOLF Magazine** |
| `greenhouse/apollo` [domain-stem] | Apollo.io (`apollo.io`) | **Apollo Education Systems** |
| `greenhouse/apollo` [domain-stem] | Apollo Health (`apollo.com`) | **Apollo Education Systems** |
| `lever/unusual` [domain-stem] | Unusual (`unusual.ai`) | **Unusual Ventures** (a VC firm) |
| `lever/unify` [domain-stem] | Unify (`unify.ai`) | **UnifyID (acquired by Prove)** |
| `lever/porter` [domain-stem] | Porter (`porter.run`) | **Porter Cares, Inc.** |
| `greenhouse/affinity` [name] | Affinity (`itsaffinity.com`) | **Affinity.co** |
| `ashby/context` [domain-stem] | Context.dev (`context.dev`) | **Context** — `publicWebsite: context.ai` |
| `ashby/prose` [domain-stem] | OpenProse (`prose.md`) | **Prose** — `publicWebsite: prose.com` |

Three findings worth the operator's attention:

1. **`greenhouse/solutions` is the worst case.** Rakuten Travel Xchange's niche-list website is
   the *subdomain* `solutions.travel.rakuten.com`, which stems to `solutions` — matching an
   unrelated board belonging to Cadence Solutions. Domain-stem matching does not guard against
   subdomains at all.
2. **`Apollo` collides twice**, from two different niche companies (`apollo.io` and `apollo.com`),
   both onto the same wrong board. One slug can absorb several distinct companies.
3. **The Affinity collision has three heads, not one.** jobhive's greenhouse `affinity` is
   *Affinity.co*, **and** its ashby `affinity` is *Affinity Analytics* — neither is YC's Affinity
   (`itsaffinity.com`). Three different companies share that name across our data.

The two ashby cases (`context`, `prose`) are especially strong evidence: the name rule flagged
them, and ashby's independently-supplied `publicWebsite` **corroborated** the flag
(`context.ai` ≠ `context.dev`, `prose.com` ≠ `prose.md`). Name-only intuition would have called
both false alarms.

### Probable mis-attributions (name-only evidence, not domain-corroborated)

| Candidate | We expected | Vendor says |
|---|---|---|
| `greenhouse/quetzal` [name] | Quetzal (`getquetzal.com`) | Quetzal International Services, SAS |
| `greenhouse/pulse` [name] | Pulse (`getpulse.care`) | Pulse Healthcare |

### Conservative false mismatches (same company, cost of the strict rule)

| Candidate | We expected | Vendor says | Note |
|---|---|---|---|
| `lever/theathletic` | The Athletic | The Athletic Media Company | same company; `Media Company` is not a legal suffix |
| `greenhouse/equalexperts` | Equal Experts Portugal | Equal Experts | same group, regional entity |
| `greenhouse/axiom` | Axiom.ai (`axiom.ai`) | Axiom | genuinely ambiguous — unresolved |

**~2–3% false-mismatch rate.** Accepting these would require prefix/containment matching, which
also confirms `Porter Cares` ⊃ `Porter` and `Affinity Analytics` ⊃ `Affinity`. Trading a 10%
mis-attribution rate for a 2.5% false-mismatch rate is the right side of that trade for a product
whose wedge is legitimacy.

---

## 5. Recommendation for the operator

1. **Do not seed on match alone.** 13.0% of live matched candidates are mis-attributed. At ~1,000
   sources that is **~130 boards feeding the wrong company's jobs to users** — directly against
   the legitimacy wedge.
2. **Domain-stem is not a safe shortcut.** It is 4× worse than name matching (20% vs 5%). Do not
   grant it an auto-confirm path. If stemming is kept, at minimum reject candidates whose
   niche-list website is a subdomain (the `solutions.travel.rakuten.com` class).
3. **Gate seeding on `confirmed`.** Verification is one extra request per candidate against
   endpoints all three vendors already serve — cheap relative to a mis-attribution.
4. **`unverifiable` is a real but small bucket: ~1% of live boards** (1/115). Route those to the
   operator/monitor. It does not need engineering around.
5. **Prefer ashby's `publicWebsite`** where present — it is the only domain-grade evidence any
   vendor gives us, and it independently caught two mis-attributions the name rule would have been
   second-guessed on.

## 6. Reproducing

- Live measurement script: `<scratchpad>/measure.mts` (`npx tsx measure.mts`), reading
  `yc-all.json`, `jobhive/*.csv`, `remote-jobs/src/companies/*.md` already present in the probe
  scratchpad. Raw output: `<scratchpad>/measure-out.json`.
- Unit tests (`identity.test.ts`, 30 tests) use an injected fetch double — **no live network**.
  The live run above is analysis, kept separate from the suite.
