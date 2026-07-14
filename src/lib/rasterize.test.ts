import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rasterizePdfPages } from "./rasterize";

const FIXTURES = join(__dirname, "..", "server", "resume", "__fixtures__");

describe("rasterizePdfPages", () => {
  it("rasterizes a PDF into PNG data-URLs, one per page up to maxPages", async () => {
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    const images = await rasterizePdfPages(bytes, 2);
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const image of images) expect(image).toMatch(/^data:image\/png;base64,/);
  });

  it("caps at maxPages even when the PDF has more pages", async () => {
    const bytes = readFileSync(join(FIXTURES, "two-page.pdf"));
    const images = await rasterizePdfPages(bytes, 1);
    expect(images).toHaveLength(1);
  });

  it("returns one image per page when maxPages allows it", async () => {
    const bytes = readFileSync(join(FIXTURES, "two-page.pdf"));
    const images = await rasterizePdfPages(bytes, 2);
    expect(images).toHaveLength(2);
  });
});
