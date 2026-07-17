# SmartRecruiters Verification — Legal Signal + Hit-Rate

Date: 2026-07-17. Scope: the open question left in design §4.2
(`docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`) —
the robots.txt legal signal, the vendor's own terms, and the "5 of 7 jobhive slugs
returned zero postings" hit-rate mystery. All claims below are grounded in HTTP responses
received 2026-07-17 with UA `Mozilla/5.0 (compatible; caliber/1.0)`, no auth, no header
spoofing, single spaced requests. **The postings API
(`api.smartrecruiters.com/v1/companies/{id}/postings`) was never called** — the legal
finding below moots it. No 403 or 429 was received on anything that was fetched.

## Verdict: DROP

The legal question was answered first, and it disqualifies. Three independent signals,
each verbatim below: (1) robots.txt on the API host is a full-site `Disallow: /` for
every agent except LinkedInBot; (2) the SAP API Policy — which SmartRecruiters' own
developer docs say governs *any* use of its APIs — expressly prohibits scraping,
systematic data extraction, *and* AI-agent-driven API calls, and names impersonation
techniques as prohibited circumvention; (3) the Posting API's documented gate is API-key
authentication for customers. This is the same standard §7 applied to Getro (verbatim
reviewed prohibition → **Dangerous**, dropped): the endpoint answering 200 without auth
does not license use the vendor's posted terms forbid. Recommendation: **drop
SmartRecruiters from the source expansion.** The 2,214 jobhive slugs are moot; the
hit-rate question dies with them.

## 1. The legal signal (disqualifying)

### robots.txt — api.smartrecruiters.com (the operative host)

Fetched 2026-07-17, HTTP/2 200, 72 bytes, verbatim and complete:

```
User-agent: LinkedInBot
Allow: /v1/companies/
User-agent: *
Disallow: /
```

Every agent except LinkedInBot is disallowed from the entire API host, including
`/v1/companies/{id}/postings`. This fetch is byte-identical to the fixture captured
earlier the same day
(`src/server/search/connectors/__fixtures__/live-verify/smartrecruiters-robots.txt`) —
independently confirmed, not copied. The design's characterisation ("a legal signal none
of the above carry") is accurate: this is an explicit machine-readable denial addressed
to us specifically. The LinkedInBot carve-out is unusable — using it would mean
identifying as LinkedInBot, which is precisely the fake-identity circumvention §7 names
as what sank hiQ and Proxycurl (and which the SAP policy separately prohibits, below).

### robots.txt — www.smartrecruiters.com

Fetched 2026-07-17, HTTP 200, 75 lines. Structure: `User-agent: *`, a sitemap
declaration, then ~70 per-company `Disallow: /{Company}/*` lines (Ubisoft, BoschGroup,
Pluralsight, NestlePurinaPetCare, …) plus `Disallow: /a/*`, `/search/`, `/?s=`,
`/web-sso/*`, `/referrals-portal/*`. Not a full-site block — but this is the marketing
site, not the host the connector would call. It doesn't soften the API host's
`Disallow: /`; it shows the company maintains robots deliberately, per host.

### The governing API terms — SAP API Policy (v.4.2026a)

SmartRecruiters' developer portal (`developers.smartrecruiters.com/docs/the-smartrecruiters-platform`)
states, verbatim:

> "Please note that any use of SmartRecruiters APIs is governed by the SAP API Policy"
> … "All references to 'SAP' within the Policy shall be interpreted as references to
> 'SmartRecruiters'"

The policy itself (`help.sap.com/doc/sap-api-policy/latest/en-US/API_Policy_latest.pdf`,
v.4.2026a, fetched and read 2026-07-17), verbatim:

> **2.2.2** "Except through and within the limits of SAP-endorsed architectures, data
> services, or service-specific pathways expressly identified and intended for such
> purposes, SAP prohibits API use for: (a) interaction or integration with (semi-)
> autonomous or generative AI systems that plan, select, or execute sequences of API
> calls, and (b) scraping, harvesting, or systematic and/or large-scale data extraction
> or replication."

> **2.2.1** "SAP prohibits any API use for purposes of: (a) competitive analysis, (b)
> enabling functions or scenarios that are not part of the Documented Use unless
> otherwise authorized by SAP, or (c) in a manner that creates a risk to system
> performance, stability, or security."

> **3** "Customers, partners, and third parties must not bypass, disable, or otherwise
> circumvent API Controls, including through intermediary services, custom code or
> developments, proxies, gateways, impersonation techniques, or similar mechanisms."

Caliber's crawler is (b) of 2.2.2 by definition — systematic extraction across 2,214
company boards — and arguably (a) as well (an agentic pipeline planning API calls).
Clause 3's "impersonation techniques" independently forecloses the LinkedInBot
carve-out. Note 2.2.2 binds "third parties", not just customers.

### The Posting API's own documentation

`developers.smartrecruiters.com/docs/posting-api`, verbatim:

> "The Posting API supports only API Key authentication method. OAuth is not supported."

The audience is described as customers building "fully customizable career sites". So
the documented gate is an API key; the unauthenticated 200 the design observed is
contra-docs behaviour (exactly as §4.2 said), not an invitation. Under §7's *Van Buren*
"gates" framing, the gate here isn't merely "currently up" as with JobStreet — the vendor
has posted three explicit signs on it (robots, API policy, auth docs).

### Candidate Terms of Use (secondary)

`www.smartrecruiters.com/legal/terms-of-use/` (candidate-scoped), verbatim prohibitions:

> "Use automatic means to access content or data from other users"

> "Harvest, collect, gather or assemble information or data regarding other users
> without their consent"

Weaker signal (it binds candidates with accounts), listed for completeness — every
terms surface this vendor publishes points the same direction.

### Applying §7's own standard

§7 dropped Getro on exactly this pattern: "its Terms verbatim prohibit
crawling/scraping/spidering … the clean `_next/data` JSON route being open does not
license use the ToS forbids." SmartRecruiters is the same pattern with *more* signals
(Getro had ToS only; SmartRecruiters has ToS + API policy + a targeted robots
`Disallow: /`). Applying the standard consistently: **BLOCKED-LEGAL → DROP.** No
rationalisation survives contact with 2.2.2(b).

## 2. The hit-rate question — moot, not answered

The 20–30 slug batch was **not run**: every request in it would hit
`api.smartrecruiters.com/v1/companies/{id}/postings`, which robots disallows and the
SAP API Policy prohibits. Running the test would itself be the violation. The "5 of 7
zeros" mystery therefore stays **UNRESOLVED — and worthless**, since no hit-rate figure
could change a legal DROP.

What can be said without live calls, for the record:

- **The identifier-mismatch hypothesis is plausible but untested.** The Posting API docs
  never publicly define where a caller finds `{companyIdentifier}` — a customer knows
  their own identifier from their account. jobhive's `smartrecruiters.csv` slugs are
  scraped from careers-page URLs; whether that string equals the API's
  `companyIdentifier` is exactly the thing a batch test would have measured. Staleness
  (companies leaving SmartRecruiters) remains the competing explanation. Neither is
  confirmed.
- **No slug data is vendored locally.** `src/server/sources/jobhive.ts` handles only
  greenhouse/lever/ashby; the SmartRecruiters CSV exists upstream in
  `kalil0321/ats-scrapers` (2,214 rows, MIT) and should now simply never be vendored.

## If the operator ever revisits

The only compliant route is the vendor's own gate: become a SmartRecruiters customer or
Marketplace partner and use the Posting API with an API key under the SAP policy's
Documented Use. That is a commercial decision, not a connector build. Everything else —
including "just try the batch once to settle the hit-rate" — is use the posted terms
prohibit. The prior report's verdict line stands unchanged:
**BLOCKED-LEGAL — drop unless the operator makes an explicit contrary legal call.**
