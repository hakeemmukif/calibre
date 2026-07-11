import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdfText, PdfParseError } from "./pdf-text";

const FIXTURES = join(__dirname, "..", "server", "resume", "__fixtures__");

describe("extractPdfText", () => {
  it("extracts text from a real PDF fixture", async () => {
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    const text = await extractPdfText(bytes);
    expect(text).toContain("Hello resume world");
  });

  it("throws PdfParseError with the original error as `cause` for corrupt/truncated PDF bytes", async () => {
    const bytes = Buffer.from("not a real pdf at all, just garbage bytes that are not valid PDF structure");
    await expect(extractPdfText(bytes)).rejects.toThrow(PdfParseError);
    try {
      await extractPdfText(bytes);
      expect.unreachable("expected extractPdfText to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PdfParseError);
      expect((err as PdfParseError).cause).toBeInstanceOf(Error);
    }
  });
});
