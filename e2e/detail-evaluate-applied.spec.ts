import { expect, test, type APIRequestContext } from "@playwright/test";

// Same >=100-char sample used across the API-bootstrap specs (see
// resume-scan-feed.spec.ts's comment on the length requirement).
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

// API-bootstrap: ingest a résumé + run a remote-persona search, then poll
// GET /api/jobs until it's non-empty. A 409 on POST /api/search is not a
// failure here — it means another spec's run is already active for this
// persona (the app holds a single process-global active-run lock keyed by
// persona, src/server/runs/registry.ts) and will populate the same shared
// `jobs` table this poll is watching.
async function bootstrapRemoteJob(request: APIRequestContext): Promise<{ id: string }> {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);

  const searchRes = await request.post("/api/search", { data: { persona: "remote" } });
  if (searchRes.status() !== 202 && searchRes.status() !== 409) {
    throw new Error(`POST /api/search failed: ${searchRes.status()} ${await searchRes.text()}`);
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const jobsRes = await request.get("/api/jobs?persona=remote");
    if (!jobsRes.ok()) throw new Error(`GET /api/jobs failed: ${jobsRes.status()} ${await jobsRes.text()}`);
    const body = (await jobsRes.json()) as { items: { id: string }[] };
    if (body.items.length > 0) return body.items[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("bootstrapRemoteJob: GET /api/jobs?persona=remote stayed empty after 20s");
}

test("job detail: re-evaluate keeps a score, mark-applied lands in the tracker", async ({ page, request }) => {
  const job = await bootstrapRemoteJob(request);

  await page.goto("/feed");
  // The card navigates via router.push() in an onClick handler (not a real
  // <a href>), so on a slow runner the click can land before React attaches
  // it — retry the click until navigation actually happens.
  await expect(async () => {
    await page.getByText("Senior Backend Engineer, Payments").first().click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`), { timeout: 2000 });
  }).toPass({ timeout: 15_000 });

  const reevaluate = page.getByRole("button", { name: "Re-evaluate" });
  await expect(reevaluate).toBeVisible();
  await reevaluate.click();
  await expect(page.getByRole("button", { name: "Re-evaluating…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-evaluate" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("4.2").first()).toBeVisible();

  await page.getByRole("button", { name: "Mark as applied" }).click();
  await expect(page.getByText(/^Applied/)).toBeVisible({ timeout: 10_000 });

  await page.goto("/tracker");
  await expect(page.getByText("Senior Backend Engineer, Payments").first()).toBeVisible();
});
