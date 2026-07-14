import { expect, test, type APIRequestContext } from "@playwright/test";

// Profile & targets journey (spec 2026-07-12 §7/§8): relocation is a feed
// predicate — flipping it re-scopes without a rescan. Doubles fixtures:
// greenhouse -> "anywhere" (bare Remote, anywhere-prior source), lever ->
// "abroad" (New York on a restricted source), jobstreet -> "local". Under
// "stay" the abroad job is gated out of scoring slots; scanning under "open"
// scores it; flipping back to "stay" hides it and stats.excluded counts it.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

async function scanRemoteUntil(
  request: APIRequestContext,
  done: (items: { company: string }[]) => boolean,
  what: string,
): Promise<void> {
  const searchRes = await request.post("/api/search", { data: { persona: "remote" } });
  if (searchRes.status() !== 202 && searchRes.status() !== 409) {
    throw new Error(`POST /api/search failed: ${searchRes.status()} ${await searchRes.text()}`);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const jobsRes = await request.get("/api/jobs?persona=remote");
    if (!jobsRes.ok()) throw new Error(`GET /api/jobs failed: ${jobsRes.status()} ${await jobsRes.text()}`);
    const body = (await jobsRes.json()) as { items: { company: string }[] };
    if (done(body.items)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`profile.spec: timed out waiting for ${what}`);
}

test("profile: relocation flip persists, reveals abroad jobs, and re-scopes the feed with zero rescan", async ({
  page,
  request,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);

  try {
    // Enter via the sidebar — exercises AppShell's newly-enabled row.
    await page.goto("/feed");
    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator("header").getByText("Profile & targets")).toBeVisible();

    const stay = page.getByRole("button", { name: "Stay in Malaysia", exact: true });
    const open = page.getByRole("button", { name: "Open to relocate", exact: true });
    await expect(stay).toHaveAttribute("aria-pressed", "true");

    // Flip to open; persistence proven across a reload (PUT round-trip).
    await open.click();
    await expect(page.getByText("Also roles abroad that require relocating.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Open to relocate", exact: true })).toHaveAttribute("aria-pressed", "true");

    // Scan under "open": the abroad fixture job (Acme US) now gets scored.
    await scanRemoteUntil(request, (items) => items.some((j) => j.company === "Acme US"), "the Acme US abroad job");

    await page.goto("/feed");
    await expect(page.getByText("Acme US", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Relocation", { exact: true }).first()).toBeVisible(); // the abroad pill

    // Flip back to "stay": same rows, instantly re-scoped — no rescan.
    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await page.getByRole("button", { name: "Stay in Malaysia", exact: true }).click();
    await expect(page.getByText("Malaysia jobs + remote roles that hire from Malaysia.")).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText("Outside your remote preferences · hidden")).toBeVisible();
    await expect(page.getByText("Acme US", { exact: false })).not.toBeVisible();

    const feed = await (await request.get("/api/jobs?persona=remote")).json();
    expect(feed.stats.excluded).toBeGreaterThanOrEqual(1);
    expect(feed.items.some((j: { company: string }) => j.company === "Acme US")).toBe(false);
  } finally {
    // Restore the seeded default for every other spec (shared scratch DB).
    const restore = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
    });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);
  }
});
