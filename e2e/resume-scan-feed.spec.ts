import { expect, test } from "@playwright/test";

// Journey F1 -> /scans (D7): paste-text résumé ingest auto-fires the
// dual-persona scan (src/app/(app)/resume/page.tsx's `startSearches`) and
// navigates to /scans, where BOTH runs are visible (the retention win — the
// old sessionStorage handoff -> /feed overlay round-trip is retired). Once a
// run reaches a terminal state, its /scans/:id detail replays the persisted
// results (ScanReplay) with the scored fixture job. No EventSource is opened
// on this path (a terminal run's detail is a plain JSON fetch), so the old
// SSE route warm-up request is no longer needed. >=100 raw chars (POST
// /api/resume's `PasteBody` schema) — trimmed length is what ResumeUpload's
// "Use this text" button gates on, so pad well past it.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

test("paste résumé -> dual-persona scan -> /scans list -> completed run replays a scored job", async ({ page }) => {
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

  await page.waitForURL("**/scans");

  // Both just-started persona runs land in the list as clickable run cards
  // (ScansList Cards carry role="button" and a "N worth · N ghost · N scored"
  // stats line; the "Scan now · …" launcher buttons don't). Prior specs may
  // have left older runs behind in the shared DB, so assert at-least-two.
  const runCards = page.getByRole("button").filter({ hasText: /\d+ worth · \d+ ghost · \d+ scored/ });
  await runCards.first().waitFor();
  expect(await runCards.count()).toBeGreaterThanOrEqual(2);

  // The list fetches once on mount (no polling), so reload until a run shows
  // a terminal tag — "Completed", or "Partial" when the daily cap stopped it.
  await expect(async () => {
    await page.reload();
    await expect(runCards.filter({ hasText: /Completed|Partial/ }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await runCards.filter({ hasText: /Completed|Partial/ }).first().click();
  await page.waitForURL(/\/scans\/[^/]+$/);

  // ScanReplay's Score section lists the fixture posting as a scored row.
  // Score is deterministic (MATCH_SCORE fixture -> 4.2); the legitimacy TIER
  // is not — src/server/score/legitimacy.ts overlays a real liveness HTTP
  // probe against the fixture posting's `applyUrl` — so assert title + score
  // only, not a pinned tier.
  await expect(page.getByText("Senior Backend Engineer, Payments").first()).toBeVisible();
  await expect(page.getByText("4.2").first()).toBeVisible();
});
