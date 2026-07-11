import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health", () => {
  it("reports mode 'doubles' when the flag is set", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const { GET } = await import("./route");
    const body = await (GET() as Response).json();
    expect(body).toEqual({ ok: true, mode: "doubles" });
  });

  it("reports mode 'real' when the flag is unset", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "");
    const { GET } = await import("./route");
    const body = await (GET() as Response).json();
    expect(body).toEqual({ ok: true, mode: "real" });
  });
});
