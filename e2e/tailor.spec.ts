import { expect, test, type APIRequestContext } from "@playwright/test";

// Same >=100-char sample used across the API-bootstrap specs (see
// resume-scan-feed.spec.ts's comment on the length requirement).
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

// See detail-evaluate-applied.spec.ts for why a 409 here is tolerated rather
// than treated as a failure.
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

test("tailor: correlate report -> generate rewrite -> diff review -> save finalizes -> real Chromium PDF", async ({
  page,
  request,
}) => {
  // bootstrapRemoteJob's /api/search scan scores the job as a side effect
  // (server/score/index.ts persists `jdFacts` on every job_scores upsert) —
  // no separate seeding call is needed before correlate.
  const job = await bootstrapRemoteJob(request);

  // Correlate step (server/tailor/correlate.ts, POST /api/tailor/correlate):
  // its own run, own `correlation_reports` row, independent of the tailor
  // run started below. Drive it directly and assert the report's rows —
  // there is no UI surface for CorrelationReport, so this is API-only.
  const correlateStart = await request.post("/api/tailor/correlate", { data: { jobId: job.id } });
  expect(correlateStart.status()).toBe(202);
  const correlateRun = (await correlateStart.json()) as { id: string };

  let report: { status: string; rows: { requirement: string; status: string }[] } | undefined;
  const correlateDeadline = Date.now() + 20_000;
  while (Date.now() < correlateDeadline) {
    const reportRes = await request.get(`/api/tailor/correlate/${correlateRun.id}`);
    expect(reportRes.ok()).toBeTruthy();
    report = await reportRes.json();
    if (report?.status === "completed" || report?.status === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(report?.status).toBe("completed");
  expect(report?.rows.length).toBeGreaterThan(0);

  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "Tailor résumé" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}/tailor$`));

  // Capture the started run's id straight off the POST /api/tailor response
  // — there's no list-by-job route, and the id isn't otherwise rendered.
  // The page's "Generate" button drives the full correlate -> rewrite ->
  // render pipeline server-side in one call (no reportId supplied, so
  // startTailor runs its own internal correlate) — the report checked above
  // proves the underlying correlate step independently.
  const [tailorResponse] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tailor",
    ),
    page.getByRole("button", { name: "Generate" }).click(),
  ]);
  const tailorRun = (await tailorResponse.json()) as { id: string };

  // Review state: TAILOR_RESULT's single "summary" diff entry renders as one
  // ChangeCard, already accepted by default (tailor/page.tsx seeds `accepted`
  // all-true on completion) — this IS the accept-all state for a 1-entry diff.
  await expect(page.getByText("Rewrote")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1 of 1 changes accepted")).toBeVisible();

  // Per-edit accept/reject: each ChangeCard's Accept/Reject chips are
  // addressed by the diff entry's own index (page.tsx's onToggle(index,
  // accept)), and now tie back to a correlation row via `diff[].target` —
  // exercise the toggle both ways before leaving the single entry accepted.
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("All changes rejected — exporting keeps your original résumé.")).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("1 of 1 changes accepted")).toBeVisible();

  // "Save copy" finalizes the run server-side (server/tailor's finalizeTailor
  // sets `finalizedAt`) — a prerequisite for the PDF route, not a separate draft.
  await page.getByRole("button", { name: "Save copy" }).click();
  await expect(page.getByText("Saved a copy of your tailored résumé.")).toBeVisible({ timeout: 10_000 });

  // Real in-process Chromium render (src/lib/pdf.ts) — never mocked in this
  // env. A launch failure must fail this test, not be caught and skipped.
  const pdfRes = await request.get(`/api/tailor/${tailorRun.id}/pdf`);
  expect(pdfRes.status()).toBe(200);
  expect(pdfRes.headers()["content-type"]).toBe("application/pdf");
  const buf = await pdfRes.body();
  expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
});
