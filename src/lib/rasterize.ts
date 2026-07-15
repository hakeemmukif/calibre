// Rasterizes PDF pages to PNG data-URLs for the vision-extraction fallback
// (image-only/near-textless PDFs). unpdf's `renderPageAsImage` +
// `@napi-rs/canvas` do the actual drawing; capped at `maxPages` (the
// resume-extraction 2-page boundary) so vision cost stays bounded.
import { getDocumentProxy, renderPageAsImage } from "unpdf";

export async function rasterizePdfPages(bytes: Uint8Array | Buffer, maxPages: number): Promise<string[]> {
  // getDocumentProxy(bytes) is used for the page COUNT only. Rendering passes
  // raw bytes (a fresh Uint8Array copy per page) to renderPageAsImage, NOT the
  // proxy: pdf.js needs the @napi-rs/canvas backend wired through
  // renderPageAsImage's own document build to decode embedded images, which the
  // getDocumentProxy build lacks — an image-heavy PDF (the actual vision
  // target) fails "@napi-rs/canvas is not available" via the proxy path but
  // renders fine via the bytes path. A fresh copy per call avoids the
  // "Cannot transfer object" error from pdf.js detaching a reused buffer.
  const pageCount = Math.min(maxPages, (await getDocumentProxy(new Uint8Array(bytes))).numPages);
  const images: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const dataUrl = await renderPageAsImage(new Uint8Array(bytes), page, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2,
      toDataURL: true,
    });
    images.push(dataUrl);
  }
  return images;
}
