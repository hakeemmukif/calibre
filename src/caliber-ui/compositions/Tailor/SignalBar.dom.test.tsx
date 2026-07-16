// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { SignalBar } from "./SignalBar";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe("SignalBar", () => {
  it("renders one div per non-zero segment (drops zero-value segments)", () => {
    const { container } = render(
      <SignalBar segments={[{ value: 3, color: "red" }, { value: 0, color: "blue" }, { value: 2, color: "green" }]} />,
    );
    const track = container.firstChild as HTMLElement;
    expect(track.children).toHaveLength(2);
  });

  it("sets each segment's flex proportional to its value", () => {
    const { container } = render(<SignalBar segments={[{ value: 3, color: "red" }, { value: 2, color: "green" }]} />);
    const track = container.firstChild as HTMLElement;
    expect((track.children[0] as HTMLElement).style.flex).toBe("3 1 0%");
    expect((track.children[1] as HTMLElement).style.flex).toBe("2 1 0%");
  });
});
