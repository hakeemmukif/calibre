import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSession }));

const { profileRepo } = vi.hoisted(() => ({ profileRepo: { get: vi.fn() } }));
vi.mock("@/server/persistence/repos/profile", async (orig) => ({
  ...(await orig<typeof import("@/server/persistence/repos/profile")>()),
  profileRepo,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import Home from "./page";
import { ProfileMissingError } from "@/server/persistence/repos/profile";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("root page — session-aware redirect", () => {
  it("redirects to /login when there is no session", async () => {
    getSession.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow("REDIRECT:/login");
    expect(profileRepo.get).not.toHaveBeenCalled();
  });

  it("redirects to /onboarding when the session has no profile", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileRepo.get.mockRejectedValue(new ProfileMissingError());
    await expect(Home()).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("redirects to /feed when the session has a profile", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileRepo.get.mockResolvedValue({ id: "p1", userId: "u1", baseCountry: "SG", relocation: "stay" });
    await expect(Home()).rejects.toThrow("REDIRECT:/feed");
  });

  it("rethrows unexpected profileRepo errors instead of redirecting", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    profileRepo.get.mockRejectedValue(new Error("db down"));
    await expect(Home()).rejects.toThrow("db down");
  });
});
