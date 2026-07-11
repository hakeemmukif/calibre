import { describe, expect, it } from "vitest";
import { htmlToText, unescapeEntities } from "./_html";

describe("htmlToText", () => {
  it("strips tags, script/style blocks, and collapses whitespace", () => {
    const html = `<div><h1>Senior  Engineer</h1><script>track()</script><style>.x{}</style><p>Build &amp; ship</p></div>`;
    expect(htmlToText(html)).toBe("Senior Engineer Build & ship");
  });
  it("handles greenhouse-style escaped HTML after unescapeEntities", () => {
    const escaped = "&lt;p&gt;Remote &amp;amp; async&lt;/p&gt;";
    expect(htmlToText(unescapeEntities(escaped))).toBe("Remote & async");
  });
});
