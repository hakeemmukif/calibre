// PDF text-layer extraction via unpdf (pdf.js under the hood). Returns
// whatever text layer is present, however short — a scanned/image-only PDF
// yields near-empty text, and the caller (server/resume/ingest.ts) routes
// that to vision extraction instead of failing. Only genuinely
// corrupt/unreadable bytes throw PdfParseError here.
import { extractText as unpdfExtractText } from "unpdf";

export class PdfParseError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PdfParseError";
    this.cause = options?.cause;
  }
}

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
  return text.trim();
}
