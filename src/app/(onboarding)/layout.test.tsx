import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSession }));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import OnboardingLayout from "./layout";

beforeEach(() => {
  getSession.mockReset();
  redirect.mockClear();
});

describe("(onboarding) layout", () => {
  it("redirects to /login when there is no session", async () => {
    getSession.mockResolvedValue(null);
    await expect(OnboardingLayout({ children: <div /> })).rejects.toThrow("REDIRECT:/login");
  });

  it("renders children (no profile check) when a session exists", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    const result = await OnboardingLayout({ children: <div>hi</div> });
    expect(result).toBeTruthy();
  });
});
