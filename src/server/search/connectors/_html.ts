// Minimal HTML→text for connector descriptions — no readability/cheerio in
// prod deps (manual-url-scan spec §7 precedent). Tag-strip THEN entity
// unescape, so escaped markup (greenhouse `content`) needs unescapeEntities
// first at the call site.
export function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return unescapeEntities(stripped).replace(/\s+/g, " ").trim();
}
