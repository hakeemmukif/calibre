// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCredits = vi.fn();

vi.mock("./client", () => ({
  getCredits: (...a: unknown[]) => getCredits(...a),
}));

import { useCredits, refreshCredits, showDenial, dismissDenial, __resetCreditsStore } from "./creditsStore";

beforeEach(() => { __resetCreditsStore(); });
afterEach(() => { vi.clearAllMocks(); });

describe("creditsStore", () => {
  it("refreshCredits populates balance/plan and notifies subscribers", async () => {
    getCredits.mockResolvedValue({ balance: 42, plan: "standard" });
    const { result } = renderHook(() => useCredits());
    expect(result.current.balance).toBeNull();
    expect(result.current.plan).toBeNull();
    await act(async () => { refreshCredits(); await Promise.resolve(); });
    expect(result.current.balance).toBe(42);
    expect(result.current.plan).toBe("standard");
  });

  it("showDenial/dismissDenial round-trip", () => {
    const { result } = renderHook(() => useCredits());
    expect(result.current.denial).toBeNull();
    act(() => { showDenial({ feature: "scan", required: 10, balance: 3 }); });
    expect(result.current.denial).toEqual({ feature: "scan", required: 10, balance: 3 });
    act(() => { dismissDenial(); });
    expect(result.current.denial).toBeNull();
  });

  it("a FAILED refresh leaves prior state untouched (no fallback zero)", async () => {
    const { result } = renderHook(() => useCredits());
    expect(result.current.balance).toBeNull();
    getCredits.mockRejectedValueOnce(new Error("network blip"));
    await act(async () => { refreshCredits(); await Promise.resolve(); });
    expect(result.current.balance).toBeNull(); // stays null, never defaults to 0

    getCredits.mockResolvedValueOnce({ balance: 7, plan: "standard" });
    await act(async () => { refreshCredits(); await Promise.resolve(); });
    expect(result.current.balance).toBe(7);

    getCredits.mockRejectedValueOnce(new Error("network blip again"));
    await act(async () => { refreshCredits(); await Promise.resolve(); });
    expect(result.current.balance).toBe(7); // a later failure doesn't reset a populated balance either
  });
});
