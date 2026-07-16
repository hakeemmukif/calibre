// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { ChangeCard } from "./ChangeCard";
import { tailored } from "../../fixtures";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe("ChangeCard", () => {
  it("labels each edit with the requirement it serves", () => {
    render(<ChangeCard change={tailored.diff[0]} accepted onToggle={() => {}} />);
    expect(screen.getByText(new RegExp(tailored.diff[0].requirement))).toBeInTheDocument();
  });
});
