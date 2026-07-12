import { expect, test, type APIRequestContext } from "@playwright/test";

// Pasted-job journey (spec 2026-07-12 §6/§9/§10/§15). All legitimacy-path
// calls in this suite are deterministic — unlike resume-scan-feed.spec.ts's
// real liveness probe — because the pasted path's `livenessOverride` is
// spec-fixed to 'active'/'uncertain', never 'expired' (§6), so no real
// network liveness check ever runs for persona:"pasted" jobs.
//
// Scenario 1 pastes both url+text (paste mode): tier-1 fetchPageText and
// tier-2 searchForPosting are both skipped (§6 ladder), so completion is
// hermetic — zero real network calls. Scenario 2 posts a bare loopback URL
// (no text): assertPublicHttpUrl denies it deterministically (no DNS, no
// live network), tier-1 fails, tier-2 runs against the scripted
// url-check-search fixture (fixed found:false — see scripted-fixtures.ts),
// yielding FETCH_BLOCKED + needsText per §15's ladder rule.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);
const PASTE_URL = "https://boards.greenhouse.io/acme/jobs/999001";
const PASTE_TEXT =
  "Senior Backend Engineer, Payments at Acme Widgets. Own the payments ledger service. " +
  "Stack: Node.js, Postgres, Kafka. Remote-friendly, Malaysia-based team welcome.\n" +
  "x".repeat(250);
const BLOCKED_URL = "http://127.0.0.1:1/pasted-job-spec-blocked-fetch";

interface UrlCheckBody {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  jobId: string | null;
  alreadyKnown: boolean;
  needsText: boolean;
  error: { code: string; message: string } | null;
}

async function pollUrlCheck(request: APIRequestContext, id: string): Promise<UrlCheckBody> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/jobs/check/${id}`);
    if (!res.ok()) throw new Error(`GET /api/jobs/check/${id} failed: ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as UrlCheckBody;
    if (body.status === "completed" || body.status === "failed") return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`pasted-job.spec: timed out polling check ${id}`);
}

test("pasted job: check -> poll -> completed, blocked-fetch needsText, alreadyKnown, delete, re-check", async ({
  request,
  page,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);

  // --- Scenario 1: paste-text happy path -> completed, job scored + legitimacy-tagged.
  const startRes = await request.post("/api/jobs/check", { data: { url: PASTE_URL, text: PASTE_TEXT } });
  expect(startRes.status()).toBe(202);
  const started = (await startRes.json()) as UrlCheckBody;
  const completed = await pollUrlCheck(request, started.id);
  expect(completed.status).toBe("completed");
  expect(completed.error).toBeNull();
  expect(completed.alreadyKnown).toBe(false);
  expect(completed.jobId).not.toBeNull();

  const jobRes = await request.get(`/api/jobs/${completed.jobId}`);
  if (!jobRes.ok()) throw new Error(`GET /api/jobs/${completed.jobId} failed: ${jobRes.status()}`);
  const job = await jobRes.json();
  expect(job.persona).toBe("pasted");
  expect(job.score).toBeGreaterThan(0);
  expect(job.legitimacy.tier).toBe("clear"); // MATCH_SCORE tier, unperturbed by the sub-threshold GHOST_WEB_EVIDENCE sighting

  const feedAfterScenario1 = await (await request.get("/api/jobs?persona=pasted")).json();
  expect(feedAfterScenario1.items.some((j: { id: string }) => j.id === completed.jobId)).toBe(true);

  // --- Scenario 2: blocked-fetch -> needsText -> re-POST with text -> completed.
  const blockedStartRes = await request.post("/api/jobs/check", { data: { url: BLOCKED_URL } });
  expect(blockedStartRes.status()).toBe(202);
  const blockedStarted = (await blockedStartRes.json()) as UrlCheckBody;
  const blocked = await pollUrlCheck(request, blockedStarted.id);
  expect(blocked.status).toBe("failed");
  expect(blocked.error?.code).toBe("FETCH_BLOCKED");
  expect(blocked.needsText).toBe(true);
  expect(blocked.jobId).toBeNull();

  const retryRes = await request.post("/api/jobs/check", { data: { url: BLOCKED_URL, text: PASTE_TEXT } });
  expect(retryRes.status()).toBe(202);
  const retryStarted = (await retryRes.json()) as UrlCheckBody;
  const retryCompleted = await pollUrlCheck(request, retryStarted.id);
  expect(retryCompleted.status).toBe("completed");
  expect(retryCompleted.error).toBeNull();
  expect(retryCompleted.jobId).not.toBeNull();

  // --- Scenario 3: alreadyKnown short-circuit — same URL as scenario 1,
  // synchronous 200 (never 202), which structurally proves zero LLM calls:
  // the admission dedupe hit returns before any queued row/async pipeline
  // starts (spec §6 step 4).
  const dupeRes = await request.post("/api/jobs/check", { data: { url: PASTE_URL, text: PASTE_TEXT } });
  expect(dupeRes.status()).toBe(200);
  const dupe = (await dupeRes.json()) as UrlCheckBody;
  expect(dupe.status).toBe("completed");
  expect(dupe.alreadyKnown).toBe(true);
  expect(dupe.jobId).toBe(completed.jobId);

  // --- Scenario 3 (rendered): same re-paste, but driven through the real
  // UI — src/app/feed/page.tsx's scopeLabel('pasted') used to throw
  // synchronously during render for exactly this alreadyKnown-pasted case,
  // crashing the whole feed route with no error boundary. The API-only
  // assertions above never caught it.
  await page.goto("/feed");
  await page.getByLabel("Job posting URL").fill(PASTE_URL);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Already tracked in your Pasted feed.")).toBeVisible();

  // --- Scenario 4: delete -> 204 -> gone from the pasted feed.
  const deleteRes = await request.delete(`/api/jobs/${completed.jobId}`);
  expect(deleteRes.status()).toBe(204);
  const feedAfterDelete = await (await request.get("/api/jobs?persona=pasted")).json();
  expect(feedAfterDelete.items.some((j: { id: string }) => j.id === completed.jobId)).toBe(false);

  // --- Scenario 5: re-check of the now-deleted job's URL — no 23505; a
  // fresh job is created (dedupeKeyFor found no job, since the old row was
  // deleted, not merely detached).
  const recheckRes = await request.post("/api/jobs/check", { data: { url: PASTE_URL, text: PASTE_TEXT } });
  expect(recheckRes.status()).toBe(202); // not alreadyKnown — the old job is gone
  const recheckStarted = (await recheckRes.json()) as UrlCheckBody;
  const recheckCompleted = await pollUrlCheck(request, recheckStarted.id);
  expect(recheckCompleted.status).toBe("completed");
  expect(recheckCompleted.error).toBeNull();
  expect(recheckCompleted.jobId).not.toBeNull();
  expect(recheckCompleted.jobId).not.toBe(completed.jobId);

  const feedAfterRecheck = await (await request.get("/api/jobs?persona=pasted")).json();
  expect(feedAfterRecheck.items.some((j: { id: string }) => j.id === recheckCompleted.jobId)).toBe(true);
});
