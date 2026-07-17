# Handoff Integration Analysis — Session B handoff × Session A (Track P) — 2026-07-17

Scope: reconcile the session-B handoff
(`…/64668023…/scratchpad/handoff-2026-07-17-remote-fit-and-remote-sources.md`) with
session A's committed + planned work on `main` (verified against real git state:
`4463875` plan revision, `4f5ad11` tz-band fix, `a0f4493` Track P plan, `6bb7209` pool
architecture, `51ec62d` spec corrections, `960f123` reports). Analysis only — no
code/doc changes were made except this report. Every claim below is quoted from the
files as they exist on `main` today.

**Provenance note.** Both sessions' verification reports are ALREADY committed on
`main` in the same commit (`960f123`): session A's
`2026-07-17-connector-live-verification.md` plus session B's
`2026-07-17-{workable-recruitee,rippling-pinpoint-teamtailor,smartrecruiters}-verification.md`.
The reports cross-reference each other (B: "This pass independently re-verified the
spec's specific claims … the same morning"). So the raw evidence is merged; what is NOT
merged is the plan/spec layer — that is what this analysis reconciles.

**Plan-lineage note.** B's handoff cites
`2026-07-17-decoupling-and-connectors.md` as "Execution" — but that plan's own successor
says: "**Supersedes** `2026-07-17-decoupling-and-connectors.md`"
(`2026-07-17-source-engine-ignition.md` header), and Track P in turn "Supersedes Track 3
(3.1–3.6) of `2026-07-17-source-engine-ignition.md`" (pool build plan header). The
current stack is: **ignition plan (Tracks 0/2b/4) + Track P (the pool) + the 2026-07-16
design spec**. B's report task numbering ("4.4a Pinpoint, 4.5a Rippling") is the
superseded plan's; the ignition plan renumbered (4.4a = robots gate, 4.5 = Pinpoint).
Any agent following B's handoff pointer must be redirected to the ignition plan + Track P.

---

## 1. Connector-verification reconciliation → merged vendor list

**Finding.** The two passes are complementary, not competing: A verified
Workable/Recruitee/Personio/Pinpoint/Rippling (UA `caliber-verify/1.0`); B re-verified
Workable/Recruitee/Pinpoint/Rippling with the **production UA** (`caliber/1.0`,
`_http.ts:5` verbatim) and added function-breadth counts + ATS-direct applyUrl
confirmation, plus **Teamtailor for the first time** (A never touched it; B never
touched Personio — neither is a conflict, each is single-sourced).

**The one real conflict — Rippling.** A: "**Build-readiness: READY**, effort M as
planned … Confidence: medium-high — mechanics all verified, but undocumented surface =
standing fragility" and ranked it **3rd** ("Rippling moves ahead of Recruitee on
reach"); the operator locked that as ignition **D6**: "Order: Workable → Personio →
Rippling → Recruitee → Pinpoint". B's handoff: "Rippling → verified but recommend
**DEFER** (no discoverable ToS, internal-host rewrite, N+1 per posting)."

B's position is **better-evidenced on the legal axis**: B ran the ToS probe A did not —
"`www.rippling.com/terms`, `/legal/terms-of-service`, `/legal/website-terms-of-use` all
404. **The terms governing `ats.rippling.com` are UNKNOWN — there is no discoverable
document to clear against**" (rippling-pinpoint-teamtailor report). A's report knew the
surface was undocumented but ranked on reach without a terms search. Note B's own
report is softer than B's handoff: "this report does not upgrade that posture" — i.e.
keep the plan's operator-acceptance gate, not a unilateral DEFER. And under the design's
own §7 register, "ToS unverified" is **Grey** (that is exactly Glints' classification),
not Dangerous — Rippling has no explicit prohibition, unlike Getro/SmartRecruiters.

**Reconciliation.** D6 is operator-locked, but it was made on A's evidence alone, and
Teamtailor (absent from D6 entirely) forces a D6 amendment anyway. Both go back to the
operator as ONE re-confirmation, with B's ToS-blank finding on the table.

**Merged, deconflicted vendor list + recommended build order** (all gated behind Track P
landing — both sessions agree: design §6/§10, Track P "Not in this plan: Connectors …
after the pool", handoff open #3):

| # | Vendor | Status | Binding reason | Verified by |
|---|---|---|---|---|
| 1 | **Workable** | BUILD first | Vendor-documented widget endpoint; robots fully open incl. `Content-Signal: … ai-input=yes`; 4,269 slugs; one call/board with `details=true` (base list has **no** description — B's key-diff) | A + B (agree) |
| 2 | **Personio** | BUILD | Vendor-documented XML syndication; 2,463 slugs (2nd-largest supply); constructed job-URL pattern live-verified | A only |
| 3 | **Teamtailor** | BUILD — **new, needs a plan task + D6 amendment** | 1,010 slugs; inline full JD + `pubDate` + `remoteStatus`; breadth RESOLVED (4 tenants); **hard requirement: per-tenant Content-Signal gate** (`ai-input=no` tenants skipped, e.g. polestar); shares the Personio XML-parser decision. Pre-build check: RSS vendor-documentation status is UNKNOWN (B: "not checked in this pass") | B only |
| 4 | **Recruitee** | BUILD | Best payload (JD+requirements inline, remote booleans, `published_at`); **per-tenant robots gate mandatory** ("a tenant can flip to `Disallow: /` at any time" — B); 888 slugs | A + B (agree) |
| 5 | **Pinpoint** | BUILD last of the cleared set | Cleanest legal footing; **no postedAt exists** (twice-confirmed) → depends on pool `firstSeenAt`, so it structurally requires Track P anyway; 350 slugs; exactly-1,000-row cap suspicion re-observed | A + B (agree) |
| 6 | **Rippling** | **CONDITIONAL — operator legal acceptance required, else defer to last** | Mechanics twice-verified (pagination, N+1 detail, `x-middleware-rewrite` internal host). New info post-D6: governing ToS UNDISCOVERABLE (B). §7 class: Grey. Build only after the operator explicitly records acceptance of the ToS-blank + fragility (the ignition-4.3 session gate); `consecutiveFailures` containment + scoring-time-only N+1 stand | A + B (mechanics agree; posture is B's finding) |
| — | **SmartRecruiters** | **DROP — final, both sessions** | robots `Disallow: /` for all but LinkedInBot; SAP API Policy §2.2.2(b) prohibits "scraping, harvesting, or systematic … extraction", §2.2.2(a) AI-agent API use, §3 impersonation; "The only compliant route is … become a SmartRecruiters customer or Marketplace partner" (B). LinkedInBot carve-out unusable (impersonation = the §7 circumvention class) | A (robots) + B (policy) |

## 2. Per-tenant crawl landmines × Track P task P.3

**Finding — correcting the question's premise: P.3 as written has NO robots gate at
all.** P.3's goal text is: "fetch-whole-board-then-write per source, sequential
single-row upserts …, per-vendor-host limiter, stop-on-429 per host, per-source delist
sweep gated on that source's fetch success, 60-day purge" — no robots, no
Content-Signal (grep across the Track P plan and the pool architecture spec: zero robots
mentions). The robots gate lives in the **ignition plan Track 4, task 4.4a**: "Reusable:
fetch `{board}/robots.txt`, parse, allow/deny, record the verdict in `config` …
`Disallow: /` → skip + marked; unreachable robots → decide + justify (do NOT default to
allow)" — scoped by D5 to Recruitee only, gating 4.4b.

That is defensible for the pool's v1 population (greenhouse/lever/ashby/jobstreet are
vendor-host APIs whose robots posture was cleared globally at design time), but B's two
landmines show 4.4a's *spec* is already too narrow for the vendors it will gate:

- **Recruitee robots is per-tenant** — covered by 4.4a as written.
- **Teamtailor Content-Signal is per-tenant** — NOT covered. Content-Signal is a line
  *inside* robots.txt (Workable's: `Content-Signal: search=yes, ai-input=yes,
  ai-train=no`), and a path-only robots parser would **wrongly pass** polestar, whose
  path rules leave `/jobs.rss` open while its Content-Signal declares
  `search=no, ai-train=no, ai-input=no`. B's rule: "Caliber feeds JD text into an LLM
  scoring pipeline — that is the `ai-input` class … **a tenant declaring `ai-input=no`
  must be skipped**."

**What the gate must become.** Generalize ignition 4.4a from "per-board robots gate" to
a **per-tenant crawl-permission check**: one module answering "may this source be
crawled for this use?" from (a) robots path rules for the endpoint path, (b) the
Content-Signal `ai-input` directive, (c) room for future machine-readable signals —
verdict recorded in `config`, and **evaluated at crawl time per run**, not only at
seed/validation time (B: "a tenant can flip to `Disallow: /` at any time — the
per-tenant robots gate is mandatory connector behaviour, not an ingest-time-only
filter"). Unreachable robots stays decide-and-justify, never default-allow. It gates
Recruitee (4.4b) **and** the new Teamtailor task, and — applied uniformly — it also
re-validates Workable's permissive signal every crawl for free.

**Touch to P.3 itself: one seam sentence, no code.** P.3's crawler loop is the
enforcement point when Track-4 tenant-hosted vendors ride it; noting that in P.3
prevents Track 4 from reopening crawler core unplanned. Do not build the gate inside
P.3 now — Track 4 is post-pool and the current three vendors don't need it
(CLAUDE.md: no speculative abstractions).

## 3. Spec-correction reconciliation (design `2026-07-16`, post-`51ec62d`)

**Finding.** A's six corrections (0.2/D3) already cover part of B's open item #4;
the rest is net-new. Against the CURRENT spec text:

**Already covered by A:**
- SmartRecruiters is already "*dropped, not merely downgraded*" in §4.2 with the robots
  verbatim, plus A's correction: "the postings API was never called … the hit-rate
  question is **moot** unless the operator makes an explicit contrary legal call; do not
  build this connector."
- Recruitee per-tenant robots is already in §4.2 ("**`robots.txt` is per-tenant, not
  global**"), as are the Workable `function`-field and Rippling pagination/N+1 corrections.

**Remaining deltas (list — do not apply without the operator):**
1. **§4.2 SmartRecruiters bullet — add the SAP API Policy citation**: developer docs'
   "any use of SmartRecruiters APIs is governed by the SAP API Policy"; §2.2.2(a)/(b)
   (AI-agent API use; scraping/systematic extraction — binds "third parties"), §3
   (impersonation forecloses the LinkedInBot carve-out); cite
   `reports/2026-07-17-smartrecruiters-verification.md` (the bullet currently cites only
   the connector-live-verification report, which has robots evidence alone).
2. **§7 "Dangerous" register — add SmartRecruiters** beside Getro (it currently lists
   only LinkedIn/Indeed/Glassdoor/SEEK-at-volume/Getro/circumvention). B's report applies
   §7's own Getro standard: "SmartRecruiters is the same pattern with *more* signals
   (Getro had ToS only; SmartRecruiters has ToS + API policy + a targeted robots
   `Disallow: /`)."
3. **§6 rollout step 4 — stale line A's corrections missed**: "SmartRecruiters only
   after a batch hit-rate check" contradicts the corrected §4.2 — per B, "Running the
   test would itself be the violation." Replace with "SmartRecruiters dropped (§4.2/§7)."
4. **§4.2 Teamtailor bullet — rewrite**: currently "RSS mechanics confirmed;
   multi-function breadth not (only sample was a design agency). Effort **S** if RSS
   suffices." Now wrong on three counts: breadth RESOLVED (polestar/luminorbank/paysend/
   unobravo — full board, all functions); slug supply exists (jobhive `teamtailor.csv`,
   **1,010 rows**, MIT); and a **per-tenant Content-Signal gate is a build requirement**
   (`ai-input=no` tenants skipped). Also note per-location item expansion (dedupe key =
   `guid`) and the custom-career-domain caveat; RSS vendor-documentation status UNKNOWN.
5. **Teamtailor plan task — net-new** (ignition Track 4 has none; B: "it needs a plan
   task (none exists — the plan's Phase 4 currently stops at SmartRecruiters)"), slotted
   per §1 above, sharing Personio's XML-parser decision, gated on the generalized
   crawl-permission gate. Requires amending operator decision **D6**.
6. **(This analysis adds) §4.2 Rippling bullet — fourth caveat**: governing ToS
   undiscoverable ("no public terms document governing this host could be located" — B);
   §7 Grey classification; operator acceptance recorded before build.
7. **(Housekeeping) §4.2 "Positive finding" jobhive totals**: add teamtailor.csv 1,010
   (~9,893 → ~10,903 new-vendor slugs; ~19.8k → ~20.8k total), and update §3's residual
   unknowns line ("Teamtailor/Pinpoint function-breadth on thin samples" — both now
   measured).

## 4. Gate-vs-rank (B open #1) × the pool cutover (P.5)

**Finding — they genuinely collide, and the hard gate lives in TWO places, not one.**
- Feed read path, `jobsFeed.ts:68-69`: `const tzBands = !isPastedScope ?
  (allowedBandsFor(profile.scheduleFlex) ?? undefined) : undefined;` (same for
  `hiringStructures` from `employmentPref`) — passed as filter conditions to
  `jobsRepo.listScored`, i.e. **hidden**, with the `countHidden`/`excluded` trust count.
- Scan scoring path, `run.ts:555-560`: "tz_band provably outside the schedule dial
  (spec §6 rider) — NULL band" passes, but a non-NULL out-of-band candidate is dropped
  **before deep scoring**. And since `listScored` **inner-joins** `jobScores`
  (`jobs.ts:200-202`), an unscored job never surfaces in the feed — so the pre-score
  gate is a de facto second hard hide. **A feed-only soft-rank change would surface
  almost nothing new**; the decision spans both call sites.
- B's fix made this urgent: pre-`4f5ad11`, tz_band was 100% NULL and both gates were
  dormant; at 96.7% population (56.5/22.7/17.5 apac/americas/emea), a strict
  `scheduleFlex` dial now genuinely hides ~40% of the pool.

P.5 rewrites exactly the second site and **carries the hard-gate semantics forward as
written**: "tz gate **reads the posting's crawl-time `tzBand`**" (Track P P.5; arch §3
step 2: "plus the existing profile gates (… tz-band gate reads the posting's stamped
`tzBand`)"). Arch §3 step 7 declares "**Feed — unchanged.**" — so `jobsFeed.ts` is
outside P.5's blast radius, but `run.ts:555-560` is inside it.

**Sequencing recommendation.**
1. **Decide before P.5 is spawned** (operator, `superpowers:brainstorming` per B's
   handoff). If the decision lands after P.5, the highest-blast-radius file
   (`exec:session`, confidence 70%) gets reopened immediately post-cutover — the worst
   ordering available.
2. **Absorb the scan-path half into P.5**: amend P.5's task text + tests with the
   decided semantics (e.g. B's floated split: `employmentPref`/`hiringStructures` stays
   a gate — currently decorative anyway at 0/23 populated, NULL passes — while
   `scheduleFlex`/tz becomes demote-not-hide). Note the economics question the decision
   must answer: does an out-of-band posting still consume a TOP_N deep-score slot?
3. **The feed half (`jobsFeed.ts` + ranking demotion) is independent** of P.5 and can
   land before it as a small separate change — but only *with* the run.ts half does it
   change what users see; alone it is cosmetic.
4. If the operator wants relief NOW (the live feed is over-hiding today), a minimal
   pre-P.5 change to `run.ts:557-560` + `jobsFeed.ts` is acceptable **provided P.5's
   task text is updated in the same commit** so the cutover cannot silently resurrect
   the hard gate.

## 5. hiring_structure deep-crawl extractor (B open #2) × the full-JD pool (D2)

**Finding — real but partial synergy; note it as a future-task rider, do not un-defer.**
B is right that this is not a bug: `hiringStructure` is stated-only by design
("`hiringStructure` needs no normalization — the enum is emitted directly, stated-only",
remote-fit design), and the deferred fix is "Deep-crawl extraction (**following apply
links past the first page**) … its own future design. The fact schema here is exactly
what it would feed; no rework when it lands" (same spec, decision 9; §risks: "apply-form
pages carry the sharpest restriction signals, e.g. literal work-authorization questions").

What the pool changes:
- **First layer becomes free**: full JD text sits in `postings.description` at crawl
  (D2, measured avg 4,289 chars), read via `getForScoring` — no re-fetch to re-run any
  extractor over the JD corpus, and it can run pool-wide offline instead of per-scan.
- **Extraction becomes posting-intrinsic and amortized**: P.4's write-back-cache
  pattern (`setFunctionTag` + `functionTagVersion` re-tag gate, provisioned in P.1) is
  the exact template — extract once per posting, every user benefits, versioned re-tag
  on extractor upgrades. Today's stamps are per-user-job and per-scan.
- **A concrete second-layer source already exists in a verified payload**: Rippling's
  detail response carries `activeJobApplication.{basicQuestions, additionalQuestions}`
  ("future `extractQuestions` material" — both A's and B's reports).

What the pool does NOT change: B's core finding stands — JDs rarely state structure
(0/23), so the extractor's marginal value comes from **apply-form/second-layer pages,
which the pool does not store**. The defining cost (politeness-budgeted fetches past
the first page) survives. Verdict: the pool makes the deferred project meaningfully
cheaper and architecturally cleaner, but does not collapse it into a quick win.

## 6. LinkedIn / blocked-source boundary check

**Boundary intact across both sessions' work.** Evidence:
- **Canon unchanged**: design §2 decision #7 "Blocked sources: LinkedIn, Indeed,
  Glassdoor, Wellfound, Remotive — never"; §10 "Wellfound/LinkedIn/Indeed/Glassdoor
  access of any kind" explicitly not built. Track P plan + pool architecture spec:
  zero references to any blocked host (grepped).
- **Session A's code**: `src/server/sources/` engine/seeding sweeps clean — the only
  hits are inert data (a vendored remoteintech sample doc that *mentions* a company's
  LinkedIn page; never fetched) and a greenhouse test fixture using "LinkedIn" as an
  application-question option label.
- **Session B reinforces, does not reopen**: request ledger states
  "LinkedIn/Indeed/Glassdoor/Wellfound/Getro were not touched"; handoff #5: decision #7
  "stays 'never' … (SmartRecruiters finding strengthened it)", and any reopen "must be a
  deliberate spec amendment addressing the *contract* theory … Do NOT route around it by
  building a crawler with a flag off." Both sessions independently refused the
  SmartRecruiters LinkedInBot carve-out as impersonation.
- **`src/server/url-check/linkedin.ts` verified to be exactly what B says**: a
  user-pasted single-URL rewrite for the F7 tier-1 fetch — hardcoded
  `GUEST_ORIGIN`, numeric-id-validated (`/^\d+$/`), passthrough for anything else
  ("never guesses an id"), no enumeration, no scan/crawler integration. It is a
  per-user-action fetch of one posting the user supplied, in the pasted-job feature —
  not ingestion. Honest tension stated for the record: it does touch `linkedin.com`
  when a user pastes a LinkedIn URL; decision #7 and §10 target *source
  ingestion/crawling*, which this is not. Leave it, per B.

---

## Prioritized integration actions

1. **[Operator + Track P plan] Gate-vs-rank decision BEFORE P.5, then amend P.5.**
   File: `docs/superpowers/plans/2026-07-17-global-postings-pool-build.md` (P.5 goal +
   test list). Why: P.5 as written rebuilds the hard tz gate; the decision spans
   `run.ts:555-560` (inside P.5) and `jobsFeed.ts:67-69` (outside it); deciding after
   cutover reopens the highest-blast-radius task. Feed-half may land as an independent
   small change; scan-half is absorbed into P.5.
2. **[Spec] One correction commit to
   `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`**:
   §4.2 SmartRecruiters + SAP §2.2.2/§3 citation; §7 Dangerous += SmartRecruiters;
   §6.4 stale "batch hit-rate check" line replaced with "dropped"; §4.2 Teamtailor
   bullet rewritten (breadth resolved, 1,010 slugs, Content-Signal gate, caveats);
   §4.2 Rippling += ToS-undiscoverable caveat (§7 Grey); jobhive totals + §3 residue
   line updated. Each edit cites its 2026-07-17 report (A's 0.2 pattern).
3. **[Ignition plan Track 4] Generalize 4.4a → per-tenant crawl-permission gate**
   (robots paths + Content-Signal `ai-input`, crawl-time evaluation, verdict recorded,
   unreachable = decide-and-justify) **+ add a Teamtailor task** gated on it (shares
   Personio's XML-parser decision) **+ one operator re-confirmation of D6** with the
   merged order (§1 table): Workable → Personio → Teamtailor → Recruitee → Pinpoint →
   Rippling-conditional; SmartRecruiters DROP final. File:
   `docs/superpowers/plans/2026-07-17-source-engine-ignition.md`.
4. **[Track P plan, one sentence] P.3 seam note**: the crawler's per-source loop is the
   enforcement point for the Track-4 crawl-permission gate — so Track 4 extends, not
   reopens, crawler core. File: the Track P plan (P.3).
5. **[Future-task note] hiring_structure extractor rides the pool**: record (in the
   ignition plan's deferred list or the remote-fit spec's deep-crawl pointer) that
   `postings.description` + the P.4 write-back-cache pattern + Rippling
   `activeJobApplication` are the extractor's inputs when it is designed — first layer
   free, second layer (apply-form fetches) remains its real cost.
6. **[Hygiene] Handoff pointer redirect**: B's handoff cites the superseded
   `2026-07-17-decoupling-and-connectors.md`; any agent resuming from it must read the
   ignition plan + Track P instead (already stated in those files' headers; no edit
   needed — noted here so it isn't rediscovered).
