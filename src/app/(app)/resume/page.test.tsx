// @vitest-environment jsdom
// D7: after a confirmed résumé upload fires the dual-persona search, the page
// navigates to /scans (both runs are visible in the list) — the sessionStorage
// scanHandoff → /feed round-trip is retired.
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

const { getResume, uploadResume, startSearch } = vi.hoisted(() => ({
  getResume: vi.fn(),
  uploadResume: vi.fn(),
  startSearch: vi.fn(),
}));
vi.mock("@/features/resume/client", () => ({ getResume, uploadResume }));
vi.mock("@/features/search/client", () => ({ startSearch }));

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
});

describe("ResumePage dual-persona auto-start", () => {
  it("fires remote+local searches after upload and navigates to /scans", async () => {
    startSearch.mockResolvedValueOnce({ id: "r-remote" }).mockResolvedValueOnce({ id: "r-local" });
    render(<ResumePage />);

    await pasteResumeText();

    await waitFor(() => expect(startSearch).toHaveBeenCalledWith({ persona: "remote" }));
    expect(startSearch).toHaveBeenCalledWith({ persona: "local" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/scans"));
  });

  it("stays on the page with a retry error when both starts fail", async () => {
    startSearch.mockRejectedValue(new Error("boom"));
    render(<ResumePage />);

    await pasteResumeText();

    expect(await screen.findByText(/Search failed to start — retry\. \(boom\)/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
