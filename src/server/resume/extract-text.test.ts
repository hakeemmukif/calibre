import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PdfParseError } from "@/lib/pdf-text";
import { ParseFailedError } from "./derive-view";
import { extractText, UnsupportedMimeError } from "./extract-text";

const FIXTURES = join(__dirname, "__fixtures__");

describe("extractText", () => {
  it("passes pasted text through unchanged", async () => {
    await expect(extractText({ text: "already-extracted résumé text" })).resolves.toBe(
      "already-extracted résumé text",
    );
  });

  it("extracts text from a real PDF fixture", async () => {
    const bytes = readFileSync(join(FIXTURES, "tiny.pdf"));
    const text = await extractText({ file: { bytes, mime: "application/pdf" } });
    expect(text).toContain("Hello resume world");
  });

  it("extracts text from a real DOCX fixture via mammoth", async () => {
    const bytes = readFileSync(join(FIXTURES, "tiny.docx"));
    const text = await extractText({
      file: { bytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
    expect(text).toContain("Jane Doe resume docx fixture");
  });

  it("throws UnsupportedMimeError for an unknown mime type", async () => {
    const bytes = Buffer.from("not a résumé");
    await expect(extractText({ file: { bytes, mime: "image/png" } })).rejects.toThrow(UnsupportedMimeError);
  });

  it("propagates PdfParseError for a scanned/empty PDF (no text layer)", async () => {
    vi.doMock("unpdf", () => ({ extractText: async () => ({ totalPages: 1, text: "" }) }));
    vi.resetModules();
    const { extractText: extractTextFresh } = await import("./extract-text");
    const { PdfParseError: PdfParseErrorFresh } = await import("@/lib/pdf-text");
    const bytes = Buffer.from("%PDF-1.4 fake bytes");
    await expect(extractTextFresh({ file: { bytes, mime: "application/pdf" } })).rejects.toThrow(PdfParseErrorFresh);
    vi.doUnmock("unpdf");
    vi.resetModules();
  });

  it("maps corrupt/truncated PDF bytes (valid mime, invalid content) to PdfParseError", async () => {
    const bytes = Buffer.from("not a real pdf at all, just garbage bytes that are not valid PDF structure");
    await expect(extractText({ file: { bytes, mime: "application/pdf" } })).rejects.toThrow(PdfParseError);
  });

  it("maps corrupt/truncated DOCX bytes (valid mime, invalid content) to ParseFailedError", async () => {
    const bytes = Buffer.from("not a real docx at all, just garbage bytes that are not a valid zip/docx structure");
    await expect(
      extractText({
        file: { bytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      }),
    ).rejects.toThrow(ParseFailedError);
  });
});
