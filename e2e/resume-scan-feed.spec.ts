import { expect, test } from "@playwright/test";

// Journey F1->F2: paste-text résumé ingest auto-fires the dual-persona scan
// (src/app/resume/page.tsx's `startSearches`) and hands the remote run off
// to /feed via sessionStorage (features/search/scanHandoff.ts). >=100 raw
// chars (POST /api/resume's `PasteBody` schema) — trimmed length is what
// ResumeUpload's "Use this text" button gates on, so pad well past it.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

test("paste résumé -> dual-persona scan handoff -> feed shows a scored, legitimacy-tagged job", async ({ page, request }) => {
  // Next.js dev server compiles each route.ts on-demand on its first hit.
  // Reproduced directly with curl against a freshly-booted `next dev`
  // (doubles mode): a search run's SSE subscription (GET /api/search/:id
  // with Accept: text/event-stream) made before this dynamic route has EVER
  // been hit gets a synthetic "not streamable" error even though the run
  // was just created seconds earlier by the already-compiled POST
  // /api/search route — the run's in-memory registry handle (a module-level
  // singleton, src/server/runs/registry.ts) isn't visible until this route
  // has compiled once. Every subsequent request in the same `next dev`
  // process works correctly (confirmed empirically). This spec is the only
  // one in the suite that opens a real EventSource (via useScanRun's SSE
  // subscription), so warm the route with one throwaway request before the
  // real flow below is the only way to make it deterministic — not a
  // product bug, purely a `next dev` on-demand-compilation artifact.
  await request.get("/api/search/00000000-0000-0000-0000-000000000000", {
    headers: { accept: "text/event-stream" },
  });

  await page.goto("/resume");

  // The DB is shared across spec files within one `test:e2e` invocation (only
  // reset once per invocation, not per spec) — a prior spec may already have
  // an active résumé, in which case this page renders ResumeView (with a
  // "Re-upload" affordance) instead of the empty ResumeUpload form. Wait for
  // whichever branch resolves, then reset to the upload form if needed.
  await page.getByRole("button", { name: /^(Re-upload|Paste text instead)$/ }).first().waitFor();
  const reupload = page.getByRole("button", { name: "Re-upload" });
  if ((await reupload.count()) > 0) await reupload.click();

  await page.getByRole("button", { name: "Paste text instead" }).click();
  await page.getByPlaceholder(/paste the plain text of your résumé/i).fill(SAMPLE_RESUME);
  await page.getByRole("button", { name: "Use this text" }).click();

  await page.waitForURL("**/feed");

  // ScanProgress overlay attaches to the remote-persona run via the handoff.
  await expect(page.getByText("Scanning the market for you")).toBeVisible();
  const viewMatches = page.getByRole("button", { name: "View your matches" });
  await expect(viewMatches).toBeVisible({ timeout: 30_000 });
  await viewMatches.click();

  // Dismissed — the row underneath must be a real JobRow with a fit score
  // ring and a legitimacy tag, not just any text on the page. Score is
  // deterministic (MATCH_SCORE fixture -> 4.2), but the legitimacy TIER is
  // not: src/server/score/legitimacy.ts overlays a real (non-doubles-gated)
  // liveness HTTP probe against the fixture posting's actual `applyUrl`
  // (src/server/score/liveness.ts) on top of the mocked LLM's "clear"
  // verdict, forcing "ghost" if that live network call reports the posting
  // 404s/410s — accept whichever of the 5 tiers actually rendered rather
  // than pin one, so this assertion doesn't ride on that network call's result.
  await expect(page.getByText("Senior Backend Engineer, Payments").first()).toBeVisible();
  await expect(page.getByText("4.2").first()).toBeVisible();
  await expect(page.getByText(/^(Verified|Clear|Suspicious|Ghost|Likely scam)$/).first()).toBeVisible();
});
