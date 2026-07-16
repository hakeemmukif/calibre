// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorrelationReport } from "@/types";

const requestJsonMock = vi.fn();
vi.mock("@/features/http", () => ({
  requestJson: (...args: unknown[]) => requestJsonMock(...args),
}));

import { getCorrelate, startCorrelate } from "./client";

afterEach(() => {
  requestJsonMock.mockReset();
});

function report(overrides: Partial<CorrelationReport> = {}): CorrelationReport {
  return {
    id: "report-1",
    jobId: "job-1",
    resumeId: "resume-1",
    status: "completed",
    progress: null,
    rows: [],
    semantic: { met: 0, buried: 0, gap: 0, total: 0 },
    ats: { present: 0, total: 0, missing: [] },
    model: "test-model",
    costUsd: 0,
    createdAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:05.000Z",
    ...overrides,
  };
}

describe("startCorrelate", () => {
  it("POSTs /api/tailor/correlate and returns the parsed CorrelationReport", async () => {
    const created = report({ status: "queued", progress: null, completedAt: null });
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse(created)),
    );

    const result = await startCorrelate({ jobId: "job-1" });

    expect(requestJsonMock).toHaveBeenCalledWith(
      "/api/tailor/correlate",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: "job-1" }) },
      expect.anything(),
    );
    expect(result).toEqual(created);
  });
});

describe("getCorrelate", () => {
  it("GETs /api/tailor/correlate/:id and returns the parsed CorrelationReport", async () => {
    const existing = report();
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse(existing)),
    );

    const result = await getCorrelate("report-1");

    expect(requestJsonMock).toHaveBeenCalledWith("/api/tailor/correlate/report-1", undefined, expect.anything());
    expect(result).toEqual(existing);
  });
});
