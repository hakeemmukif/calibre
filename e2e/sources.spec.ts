import { expect, test } from "@playwright/test";

// Sources page (src/app/sources/page.tsx): GET /api/sources rows "ordered by
// name" (route comment), grouped by persona. Toggle by aria-label rather
// than a hardcoded source name — alphabetical order puts "Ashby" first in
// the remote group, not "Greenhouse" (the one source the fixture connector
// actually yields a posting for), so this never disturbs other specs'
// remote-persona bootstraps.
test("sources: persona groups render; first remote source toggle persists across reload", async ({ page }) => {
  await page.goto("/sources");

  await expect(page.getByText("Remote · global")).toBeVisible();
  await expect(page.getByText("Malaysia · local")).toBeVisible();

  const toggle = page.getByRole("button", { name: /^Toggle /i }).first();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText("Enabled");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const label = await toggle.getAttribute("aria-label");
  if (!label) throw new Error("first remote source toggle has no aria-label");

  await toggle.click();
  await expect(toggle).toHaveText("Disabled");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  const toggleAfterReload = page.getByRole("button", { name: label });
  await expect(toggleAfterReload).toHaveText("Disabled");
  await expect(toggleAfterReload).toHaveAttribute("aria-pressed", "false");

  await toggleAfterReload.click();
  await expect(toggleAfterReload).toHaveText("Enabled");
  await expect(toggleAfterReload).toHaveAttribute("aria-pressed", "true");
});
