// @vitest-environment jsdom
// D7 pivot (membership-credits Task 8): upload no longer auto-starts a scan.
// The user reviews the parsed résumé, then explicitly picks a persona to
// start exactly one scan, which navigates straight to /scans/:id.
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { resume } from "@/caliber-ui/fixtures";

afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const { getResume, uploadResume, startSearch, getProfile, updateProfile } = vi.hoisted(() => ({
  getResume: vi.fn(),
  uploadResume: vi.fn(),
  startSearch: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock("@/features/resume/client", () => ({ getResume, uploadResume }));
vi.mock("@/features/search/client", () => ({ startSearch }));
vi.mock("@/features/profile/client", () => ({ getProfile, updateProfile }));

// Complete profile with targetRole set — the finish-setup card is out of
// scope for the existing review-then-scan flow tests below.
const PROFILE = {
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "base-hours",
  employmentPref: "any",
  displayLocation: "Kuala Lumpur, Malaysia",
  targetRole: "Backend Engineer",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryCadence: null,
  attrProvenance: {},
  updatedAt: "2026-07-14T00:00:00.000Z",
};

import ResumePage from "./page";

// jsdom's File has no .text() — the page's paste path calls it. Polyfill via
// FileReader (which jsdom does implement) so handleFile can read the paste.
if (typeof File.prototype.text !== "function") {
  File.prototype.text = function (this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// >=100 trimmed chars — ResumeUpload's "Use this text" gate.
const PASTED_TEXT = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

async function pasteResumeText() {
  fireEvent.click(await screen.findByRole("button", { name: "Paste text instead" }));
  fireEvent.change(screen.getByPlaceholderText(/paste the plain text of your résumé/i), {
    target: { value: PASTED_TEXT },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this text" }));
}

beforeEach(() => {
  push.mockReset();
  getResume.mockReset();
  getResume.mockResolvedValue(null);
  uploadResume.mockReset();
  uploadResume.mockResolvedValue(resume);
  startSearch.mockReset();
  getProfile.mockReset();
  getProfile.mockResolvedValue(PROFILE);
  updateProfile.mockReset();
});

describe("ResumePage review-then-scan flow", () => {
  it("does not auto-start a scan after upload, and prompts to scan", async () => {
    render(<ResumePage />);

    await pasteResumeText();

    expect(await screen.findByText("Résumé ready")).toBeInTheDocument();
    expect(startSearch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("starts exactly one scan for the chosen persona and navigates to /scans/:id", async () => {
    startSearch.mockResolvedValueOnce({ id: "r-remote" });
    render(<ResumePage />);

    await pasteResumeText();

    fireEvent.click(await screen.findByRole("button", { name: "Scan remote roles" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/scans/r-remote"));
    expect(startSearch).toHaveBeenCalledTimes(1);
    expect(startSearch).toHaveBeenCalledWith({ persona: "remote" });
  });

  it("surfaces a retry error and stops the launching state when the scan fails to start", async () => {
    startSearch.mockRejectedValueOnce(new Error("boom"));
    render(<ResumePage />);

    await pasteResumeText();

    fireEvent.click(await screen.findByRole("button", { name: "Scan local roles" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("dismisses the scan prompt via Not now without starting a scan", async () => {
    render(<ResumePage />);

    await pasteResumeText();

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

    expect(screen.queryByText("Résumé ready")).not.toBeInTheDocument();
    expect(startSearch).not.toHaveBeenCalled();
  });
});
