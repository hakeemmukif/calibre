import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSession }));

const { profileGet } = vi.hoisted(() => ({ profileGet: vi.fn() }));
vi.mock("@/server/persistence/repos/profile", () => {
  class ProfileMissingError extends Error {}
  return { profileRepo: { get: profileGet }, ProfileMissingError };
});

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

vi.mock("../AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

import AppLayout from "./layout";
import { ProfileMissingError } from "@/server/persistence/repos/profile";

beforeEach(() => {
  getSession.mockReset();
  profileGet.mockReset();
  redirect.mockClear();
});

describe("(app) layout", () => {
  it("redirects to /login when there is no session", async () => {
    getSession.mockResolvedValue(null);
    await expect(AppLayout({ children: <div /> })).rejects.toThrow("REDIRECT:/login");
    expect(profileGet).not.toHaveBeenCalled();
  });

  it("redirects to /onboarding when the session has no profile", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileGet.mockRejectedValue(new ProfileMissingError());
    await expect(AppLayout({ children: <div /> })).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("re-throws a non-ProfileMissingError from the profile lookup", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileGet.mockRejectedValue(new Error("db down"));
    await expect(AppLayout({ children: <div /> })).rejects.toThrow("db down");
  });

  it("renders AppShell with children when the session has a profile", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileGet.mockResolvedValue({ id: "p1", userId: "u1", baseCountry: "MY", relocation: "stay" });
    const result = await AppLayout({ children: <div>hi</div> });
    expect(result).toBeTruthy();
  });
});
