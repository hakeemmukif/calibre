// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { initAnalytics } = vi.hoisted(() => ({ initAnalytics: vi.fn() }));
vi.mock("./client", () => ({ initAnalytics }));

import { PostHogInit } from "./PostHogInit";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PostHogInit", () => {
  it("initialises analytics on mount and renders nothing", () => {
    const { container } = render(<PostHogInit />);
    expect(initAnalytics).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
