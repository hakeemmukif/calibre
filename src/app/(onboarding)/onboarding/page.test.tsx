// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const { updateProfile } = vi.hoisted(() => ({ updateProfile: vi.fn() }));
vi.mock("@/features/profile/client", () => ({ updateProfile }));

import OnboardingPage from "./page";

beforeEach(() => {
  push.mockReset();
  updateProfile.mockReset();
});

describe("OnboardingPage", () => {
  it("saves the chosen relocation preference and redirects to /feed", async () => {
    updateProfile.mockResolvedValue({
      baseCountry: "MY", relocation: "open",
      scheduleFlex: "any-hours", employmentPref: "any",
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Open to relocate" }));
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        baseCountry: "MY", relocation: "open",
        scheduleFlex: "any-hours", employmentPref: "any",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/feed"));
  });

  it("shows the server error message and does not redirect on failure", async () => {
    updateProfile.mockRejectedValue(new Error("Couldn't save your profile."));
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(await screen.findByText("Couldn't save your profile.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
