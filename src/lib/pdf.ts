// In-process Playwright-Chromium PDF renderer (system-architecture.md §6
// decision 5: "Playwright-Chromium baked into the Docker image, invoked
// in-process — validate the base image in Phase B"). Only `server/tailor`
// (via `renderTailorPdf`) calls this.
//
// DEFERRED GATE: Chromium binaries are NOT fetched in this dev/CI
// environment (carried over from B6's Playwright liveness-probe note), so
// this module is never exercised by `npm test` — every tailor/pdf test
// mocks this module's `htmlToPdf` export (`vi.mock("@/lib/pdf")`) instead of
// launching a real browser. Validate for real by running, on the target
// Docker base image (which has `npx playwright install --with-deps chromium`
// baked in): `node -e "require('./src/lib/pdf').htmlToPdf('<h1>ok</h1>').then(buf => require('fs').writeFileSync('/tmp/test.pdf', buf))"`
// and confirming `/tmp/test.pdf` opens as a valid one-page PDF. Still an open
// item — no CI job runs this yet.
import { chromium } from "playwright";

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4" });
    return pdf;
  } finally {
    await browser.close();
  }
}
