// Route input (upload bytes+mime, or pasted text) → raw résumé text.
// PDF/DOCX dispatch by mime; donor rejects .docx, we add it via mammoth.
import mammoth from "mammoth";
import { extractPdfText } from "@/lib/pdf-text";
import { ParseFailedError } from "./derive-view";

export class UnsupportedMimeError extends Error {
  constructor(mime: string) {
    super(`Unsupported résumé mime type "${mime}" — expected PDF or DOCX.`);
    this.name = "UnsupportedMimeError";
  }
}

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface ExtractTextInput {
  file?: { bytes: Buffer; mime: string };
  text?: string;
}

export async function extractText(input: ExtractTextInput): Promise<string> {
  if (input.text !== undefined) return input.text;
  if (!input.file) throw new Error("extractText: input must include either `file` or `text`");

  const { bytes, mime } = input.file;
  if (mime === PDF_MIME) return extractPdfText(bytes);
  if (mime === DOCX_MIME) {
    try {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      return value;
    } catch (cause) {
      throw new ParseFailedError(
        "Could not read this DOCX — the file may be corrupt or truncated. Please re-export and re-upload, or paste the résumé text instead.",
        { cause },
      );
    }
  }
  throw new UnsupportedMimeError(mime);
}
