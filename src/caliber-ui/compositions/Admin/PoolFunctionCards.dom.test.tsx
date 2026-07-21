// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { PoolFunctionCards } from "./PoolFunctionCards";
import type { AdminPoolStats } from "../../../types";

afterEach(cleanup);

describe("PoolFunctionCards tie handling (spec §1.3, exactly one red)", () => {
  it("gives the accent-ink numeral to exactly one bucket when two tie on max count", () => {
    const mix: AdminPoolStats["functionMix"] = [
      { bucket: "engineering", count: 500, share: 50, source: "tag" },
      { bucket: "sales", count: 500, share: 50, source: "keyword" },
      { bucket: "other", count: 10, share: 1, source: "keyword" },
    ];

    const { container } = render(<PoolFunctionCards mix={mix} />);

    const accented = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.color === "var(--accent-ink)",
    );
    expect(accented).toHaveLength(1);
    expect(accented[0]?.textContent).toBe("500");

    // The winner is the first tied bucket (lowest index) — "engineering".
    const cards = container.firstElementChild?.children;
    expect(cards?.[0]?.contains(accented[0] ?? null)).toBe(true);
    expect(cards?.[1]?.contains(accented[0] ?? null)).toBe(false);
  });
});
