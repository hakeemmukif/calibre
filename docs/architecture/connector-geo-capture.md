# Connector geo payload captures

Live captures resolving the four repo-documented unknowns before widening any
connector interface (2026-07-12-remote-local-eligibility-design.md §5 Layer B).
Rule applied: **only confirmed fields get read**; everything else stays with
the `parseLocationGeo` string parser.

## 2026-07-12 captures

### Ashby (`api.ashbyhq.com/posting-api/job-board/ramp`) — CONFIRMED, widened
- `isRemote: boolean` — present and reliable (`true` on "Remote (US)" postings). → `geo.workMode: "remote"`.
- `address.postalAddress.addressCountry` — full country NAME ("United States"). → mapped to ISO-2 via `parseLocationGeo`'s country tokens.
- `workplaceType`, `secondaryLocations[].address` also present — NOT read yet (workplaceType redundant with isRemote for our tiers; secondaryLocations deferred).

### Lever (`api.lever.co/v0/postings/toptal?limit=1`) — CONFIRMED, widened
- `country: "US"` — ISO-3166-1 alpha-2. → `geo.countryCode`.
- `workplaceType: "remote"` — also observed values map to remote/hybrid/onsite. → `geo.workMode`.
- `categories.allLocations: string[]` present — NOT read (single `categories.location` string already parsed).

### Greenhouse (`boards-api.greenhouse.io/v1/boards/gitlab/jobs`) — NOTHING TO WIDEN
- `offices` is `null` on gitlab's board; no remote flag, no country field.
- `location.name` remains the only geo signal (e.g. `"Remote, Italy"` — comma-scoped
  remote strings; country coverage depends on `parseLocationGeo`'s token table).
- Decision: string parser stays the source for greenhouse. Revisit only if a
  board is observed emitting `offices[]`.

### JobStreet v5 (`my.jobstreet.com/api/jobsearch/v5/search?siteKey=MY-Main`) — CONFIRMED, widened
- `locations[].countryCode: "MY"` — real ISO codes per location. → `geo.countryCode` (first entry carrying one).
- `workArrangements.displayText` — observed `"Hybrid"`; values map remote/hybrid/on-site. → `geo.workMode`.
- `locations[].label` confirmed as before; multi-location arrays real (join fix shipped in Task 6).

## Resolver interaction

`resolveEligibility` MERGES `connectorGeo` over `parseLocationGeo(location)`
(structured fields override, the string fills gaps) — a partial structured geo
(e.g. Ashby `isRemote` only) never erases the country the string carries.

## Live tier-distribution (measurement gate, spec §11)

Pending an operator-run real scan (`npm run eligibility:report` after one
remote + one local scan with real `DATABASE_URL`/`OPENROUTER_API_KEY`).
Paste the distribution here; if `unknown` > ~50%, prioritize the phase-2
Remotive-class aggregator + prior/parser tuning.
