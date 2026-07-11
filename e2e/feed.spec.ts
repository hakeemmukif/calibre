import { expect, test } from "@playwright/test";

test("feed renders with persona toggle and sidebar", async ({ page }) => {
  await page.goto("/feed");
  await expect(page.getByText("Remote · global")).toBeVisible();
  await expect(page.getByText("Matches")).toBeVisible();
});
