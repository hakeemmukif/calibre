// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { writeScanHandoff, takeScanHandoff } from "./scanHandoff";

afterEach(() => sessionStorage.clear());

describe("scanHandoff", () => {
  it("round-trips the run ids written before navigation", () => {
    writeScanHandoff({ remote: "run-r", local: "run-l" });
    expect(takeScanHandoff()).toEqual({ remote: "run-r", local: "run-l" });
  });

  it("take clears the handoff so a later read is empty (single-use)", () => {
    writeScanHandoff({ remote: "run-r" });
    takeScanHandoff();
    expect(takeScanHandoff()).toEqual({});
  });

  it("writing an empty handoff stores nothing", () => {
    writeScanHandoff({});
    expect(sessionStorage.getItem("caliber.scan.runIds")).toBeNull();
  });

  it("degrades to empty on a corrupt stored value rather than throwing", () => {
    sessionStorage.setItem("caliber.scan.runIds", "not json{");
    expect(takeScanHandoff()).toEqual({});
  });
});
