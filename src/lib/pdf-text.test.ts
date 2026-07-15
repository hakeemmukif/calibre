import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractPdfText, PdfParseError } from "./pdf-text";

const FIXTURES = join(__dirname, "..", "server", "resume", "__fixtures__");

describe("extractPdfText", () => {
  it("extracts text from a real PDF fixture", async () => {
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    const text = await extractPdfText(bytes);
    expect(text).toContain("Hello resume world");
  });

  it("returns short/empty text instead of throwing — the caller routes to vision, not this module", async () => {
    vi.doMock("unpdf", () => ({ extractText: async () => ({ totalPages: 1, text: "" }) }));
    vi.resetModules();
    const { extractPdfText: extractPdfTextFresh } = await import("./pdf-text");
    const bytes = Buffer.from("%PDF-1.4 fake bytes");
    await expect(extractPdfTextFresh(bytes)).resolves.toBe("");
    vi.doUnmock("unpdf");
    vi.resetModules();
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
