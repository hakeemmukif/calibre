import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveContext, type ArchiveWriter } from "@/server/sources/archive";
import { ConnectorHttpError, fetchJson, fetchText, postJson } from "./_http";

function fakeWriter(): ArchiveWriter {
  return {
    archiveResponse: vi.fn(),
    appendPosting: vi.fn(),
    writeManifest: vi.fn(),
    errorCount: () => 0,
    close: () => Promise.resolve(),
  };
}

describe("_http archive tee", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchJson tees the raw body when called inside an archive context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const writer = fakeWriter();

    const result = await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      fetchJson("https://example.com/x"),
    );

    expect(result).toEqual({ a: 1 });
    expect(writer.archiveResponse).toHaveBeenCalledTimes(1);
    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({
        url: "https://example.com/x",
        method: "GET",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ a: 1 }),
      }),
    );
  });

  it("fetchJson does NOT tee when called outside an archive context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200 })));
    const writer = fakeWriter();

    const result = await fetchJson("https://example.com/x"); // no archiveContext.run wrapper

    expect(result).toEqual({ a: 1 });
    expect(writer.archiveResponse).not.toHaveBeenCalled();
  });

  it("fetchJson does NOT tee on a non-2xx response, even inside a context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const writer = fakeWriter();

    await expect(
      archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () => fetchJson("https://example.com/x")),
    ).rejects.toThrow(ConnectorHttpError);
    expect(writer.archiveResponse).not.toHaveBeenCalled();
  });

  it("postJson tees the raw body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const writer = fakeWriter();

    await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      postJson("https://example.com/search", { q: "engineer" }),
    );

    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({ url: "https://example.com/search", method: "POST", status: 200, body: JSON.stringify({ ok: true }) }),
    );
  });

  it("fetchText tees the raw body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>plain</html>", { status: 200, headers: { "content-type": "text/html" } })));
    const writer = fakeWriter();

    const result = await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      fetchText("https://example.com/page"),
    );

    expect(result).toBe("<html>plain</html>");
    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({ url: "https://example.com/page", method: "GET", status: 200, body: "<html>plain</html>" }),
    );
  });
});
