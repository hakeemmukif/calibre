# Caliber — Product Analytics (PostHog Cloud) — Design

**Date:** 2026-07-21
**Status:** Approved (operator-reviewed in brainstorm session)
**Scope:** Add user-behaviour analytics to Caliber to inform product development. Operator has no prior analytics experience; the design optimises for zero ops burden and minimal code.

## 1. Goals

Answer three questions, in priority order:

1. **Feature usage + funnels** — which features get used (scan, tailor, tracker) and where users drop off (signup → first scan → first application).
2. **Traffic & acquisition** — visitors, landing pages, referrers.
3. **Errors** — uncaught client-side errors users actually hit.

Explicitly deferred: session replay, server-side event capture, self-hosting, custom in-app event tables.

## 2. Decision: PostHog Cloud (EU region), free tier

- One tool covers all three goals: product analytics, funnels, web analytics, error tracking.
- Free tier = 1M events/month, no card. At current scale (n ≤ 20 invite-gated users) usage is a rounding error.
- EU region chosen for the privacy-friendlier default; ingestion is async so SEA latency is irrelevant.
- Rejected alternatives:
  - *Self-hosted PostHog* — needs ClickHouse/Kafka/4GB+ RAM; not sensible on the shared Contabo box.
  - *Umami/Plausible self-hosted* — traffic-only; weak custom events, no funnels worth the name, no error tracking; would force a second tool.
  - *Roll-our-own events table* — every chart/funnel becomes bespoke SQL; only sees server actions.

## 3. Client wiring

- `posthog-js` initialised once via a small `"use client"` provider component mounted in `src/app/layout.tsx`.
- Config: autocapture ON (clicks + pageviews, including App Router route changes — no per-page code), exception autocapture ON, session replay OFF, all input fields masked.
- Env vars: `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`. Fail loud: if the key is absent in production, log a clear warning; analytics simply does not initialise (no fallback key, no silent stub).
- **Reverse proxy:** Next.js rewrites route `/ingest/*` → PostHog EU ingestion host so adblockers do not drop events (~5 lines in `next.config`).

## 4. Identity — pseudonymous

- On login: `posthog.identify(<internal user id>)` — the internal ID only (e.g. `usr_abc123`). Never email or name.
- On logout: `posthog.reset()`.
- This unlocks retention curves, per-user journeys, and the signup → first-scan → first-application funnel while keeping PII out of the third party. The operator can map an ID back via the local DB when needed.

## 5. Custom events — starter taxonomy (5 only)

| Event | Fired when |
|---|---|
| `resume_uploaded` | user uploads a résumé |
| `scan_started` | user triggers a job scan |
| `application_created` | user adds an application to the tracker |
| `tailor_started` | user starts a tailoring run |
| `credits_depleted` | user hits zero credits on an action |

Fired from the `features/*` client code where the user triggers the action. Everything else rides on autocapture. New events are added only when a concrete product question requires one.

## 6. Privacy & compliance

- Input masking ON — résumé text and job URLs never leave the browser as event payload.
- Pseudonymous IDs, EU data residency.
- Audience is Malaysia/SEA: not under GDPR; PDPA does not mandate cookie banners. No consent banner shipped. Revisit if the audience materially shifts into the EU.

## 7. Error handling & testing

- Exception autocapture covers uncaught client errors; the root error boundary additionally calls `posthog.captureException`.
- The provider component and event-name constants get unit tests (event names as a typed constant module so typos fail at compile time).
- Manual verification: run the app locally with a dev PostHog project key, click through signup → scan, confirm events + identify appear in PostHog's live events view.

## 8. Footprint

~3 small files touched (~80 lines): provider component, event-constants module, `next.config` rewrite + layout mount. Signup-to-working estimated under one hour.
