// Real-Playwright smoke: `npm test` mocks `htmlToPdf` everywhere (Chromium
// isn't fetched in dev/CI — see src/lib/pdf.ts's header note). This is the
// only place that actually launches a browser and renders a PDF.
import { describe, expect, it } from "vitest";
import { htmlToPdf } from "@/lib/pdf";

describe("pdf smoke", () => {
  it("renders a real one-page PDF via Playwright-Chromium", async () => {
    const pdf = await htmlToPdf("<h1>ok</h1>");
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
