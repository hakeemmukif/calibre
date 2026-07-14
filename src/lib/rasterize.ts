// Rasterizes PDF pages to PNG data-URLs for the vision-extraction fallback
// (image-only/near-textless PDFs). unpdf's `renderPageAsImage` +
// `@napi-rs/canvas` do the actual drawing; capped at `maxPages` (the
// resume-extraction 2-page boundary) so vision cost stays bounded.
import { getDocumentProxy, renderPageAsImage } from "unpdf";

export async function rasterizePdfPages(bytes: Uint8Array | Buffer, maxPages: number): Promise<string[]> {
  const data = new Uint8Array(bytes);
  const proxy = await getDocumentProxy(data);
  const pageCount = Math.min(maxPages, proxy.numPages);
  const images: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const dataUrl = await renderPageAsImage(proxy, page, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2,
      toDataURL: true,
    });
    images.push(dataUrl);
  }
  return images;
}
