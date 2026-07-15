import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PdfParseError } from "@/lib/pdf-text";
import { ParseFailedError } from "./derive-view";
import { extractText, ResumeTooLongError, UnsupportedMimeError } from "./extract-text";

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

  it("accepts pasted text at exactly the 12,000-char cap", async () => {
    const text = "a".repeat(12_000);
    await expect(extractText({ text })).resolves.toBe(text);
  });

  it("throws ResumeTooLongError when pasted text exceeds the ~2-page cap", async () => {
    await expect(extractText({ text: "a".repeat(12_001) })).rejects.toThrow(ResumeTooLongError);
  });

  it("throws UnsupportedMimeError for an unknown mime type", async () => {
    const bytes = Buffer.from("not a résumé");
    await expect(extractText({ file: { bytes, mime: "image/png" } })).rejects.toThrow(UnsupportedMimeError);
  });

  it("returns empty text for a scanned/image-only PDF (no text layer) — ingest.ts decides whether to route to vision", async () => {
    vi.doMock("unpdf", () => ({ extractText: async () => ({ totalPages: 1, text: "" }) }));
    vi.resetModules();
    const { extractText: extractTextFresh } = await import("./extract-text");
    const bytes = Buffer.from("%PDF-1.4 fake bytes");
    await expect(extractTextFresh({ file: { bytes, mime: "application/pdf" } })).resolves.toBe("");
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
