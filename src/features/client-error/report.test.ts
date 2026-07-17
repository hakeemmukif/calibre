// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { reportClientError } from "./report";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportClientError (Task 4 review fix)", () => {
  it("never throws, even when constructing the report reads a hostile error", () => {
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), { sendBeacon: vi.fn(() => true) }),
    );

    const hostile = Object.create(Error.prototype) as Error & { digest?: string };
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("hostile message getter");
      },
    });
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("hostile stack getter");
      },
    });

    expect(() => reportClientError(hostile)).not.toThrow();
  });
});
