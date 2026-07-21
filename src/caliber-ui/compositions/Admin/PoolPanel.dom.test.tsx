// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { PoolPanel } from "./PoolPanel";
import { adminPoolStats } from "../../fixtures";

afterEach(cleanup);

describe("PoolPanel whole-tab single-red invariant (spec §1.3)", () => {
  it("renders exactly one accent-ink-styled element across the populated tab", () => {
    const { container } = render(<PoolPanel stats={adminPoolStats} loading={false} />);

    const accented = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.color === "var(--accent-ink)",
    );
    expect(accented).toHaveLength(1);
  });
});
