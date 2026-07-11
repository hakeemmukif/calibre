// PDF text-layer extraction via unpdf (pdf.js under the hood). Text-layer
// only — scanned/image-only PDFs have no extractable text and throw
// PdfParseError; no OCR in v1 (docs/architecture/system-architecture.md §5
// "Résumé parsing fidelity").
import { extractText as unpdfExtractText } from "unpdf";

export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfParseError";
  }
}

const MIN_TEXT_LENGTH = 20;

export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<string> {
  // unpdf rejects Node's `Buffer` at runtime even though it's a `Uint8Array`
  // subclass — copy into a plain `Uint8Array` first.
  const data = new Uint8Array(bytes);
  const { text } = await unpdfExtractText(data, { mergePages: true });
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) {
    throw new PdfParseError(
      "No extractable text layer found in this PDF (likely a scanned/image-only document) — no OCR in v1. Please paste the résumé text instead.",
    );
  }
  return trimmed;
}
