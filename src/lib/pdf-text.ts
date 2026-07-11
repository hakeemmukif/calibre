// PDF text-layer extraction via unpdf (pdf.js under the hood). Text-layer
// only — scanned/image-only PDFs have no extractable text and throw
// PdfParseError; no OCR in v1 (docs/architecture/system-architecture.md §5
// "Résumé parsing fidelity").
import { extractText as unpdfExtractText } from "unpdf";

export class PdfParseError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PdfParseError";
    this.cause = options?.cause;
  }
}

const MIN_TEXT_LENGTH = 20;

export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<string> {
  // unpdf rejects Node's `Buffer` at runtime even though it's a `Uint8Array`
  // subclass — copy into a plain `Uint8Array` first.
  const data = new Uint8Array(bytes);
  let text: string;
  try {
    ({ text } = await unpdfExtractText(data, { mergePages: true }));
  } catch (cause) {
    throw new PdfParseError(
      "Could not read this PDF — the file may be corrupt or truncated. Please re-export and re-upload, or paste the résumé text instead.",
      { cause },
    );
  }
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) {
    throw new PdfParseError(
      "No extractable text layer found in this PDF (likely a scanned/image-only document) — no OCR in v1. Please paste the résumé text instead.",
    );
  }
  return trimmed;
}
