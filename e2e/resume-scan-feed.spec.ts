import { expect, test } from "@playwright/test";

// Journey F1 -> /scans/:id (D7 review-then-scan pivot): paste-text résumé
// ingest no longer auto-fires a scan — the page shows a "Résumé ready"
// prompt (src/app/(app)/resume/page.tsx's `handleScan`), and the user
// explicitly clicks a persona button to start exactly one scan, which
// navigates straight to that run's /scans/:id detail (the old dual-persona
// auto-launch -> /scans list round-trip is retired). Once the run reaches a
// terminal state, its detail replays the persisted results (ScanReplay) with
// the scored fixture job. No EventSource is opened on this path (a terminal
// run's detail is a plain JSON fetch), so the old SSE route warm-up request
// is no longer needed. >=100 raw chars (POST /api/resume's `PasteBody`
// schema) — trimmed length is what ResumeUpload's "Use this text" button
// gates on, so pad well past it.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

test("paste résumé -> explicit remote scan -> /scans/:id -> completed run replays a scored job", async ({ page }) => {
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

  // Upload no longer auto-scans: the "Résumé ready" prompt Card appears
  // above ResumeView, and the run only starts once the persona button is
  // clicked.
  await expect(page.getByText("Résumé ready")).toBeVisible();
  await page.getByRole("button", { name: "Scan remote roles" }).click();

  // handleScan navigates straight to the new run's detail page.
  await page.waitForURL(/\/scans\/[^/]+$/);

  // The detail page swaps to ScanReplay once its status flips terminal —
  // ScanReplay renders the raw `detail.status` ("completed"/"failed", lower
  // case) plus a "Partial — daily cap" tag when the daily cap stopped it.
  // Reload until one shows up (mirrors the old list-page polling; the SSE
  // bridge should also refetch on its own, but reload is the robust
  // fallback).
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/completed|partial/i).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // ScanReplay's Score section lists the fixture posting as a scored row.
  // Score is deterministic (MATCH_SCORE fixture -> 4.2); the legitimacy TIER
  // is not — src/server/score/legitimacy.ts overlays a real liveness HTTP
  // probe against the fixture posting's `applyUrl` — so assert title + score
  // only, not a pinned tier.
  await expect(page.getByText("Senior Backend Engineer, Payments").first()).toBeVisible();
  await expect(page.getByText("4.2").first()).toBeVisible();
});
