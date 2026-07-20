import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

import { EVENTS } from "./events";
import {
  __resetAnalyticsForTest,
  captureException,
  identify,
  initAnalytics,
  resetAnalytics,
  track,
} from "./client";

beforeEach(() => {
  __resetAnalyticsForTest();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("event taxonomy (spec §5)", () => {
  it("matches the spec's snake_case names exactly", () => {
    expect(EVENTS).toEqual({
      resumeUploaded: "resume_uploaded",
      scanStarted: "scan_started",
      applicationCreated: "application_created",
      tailorStarted: "tailor_started",
      creditsDepleted: "credits_depleted",
    });
  });
});

describe("analytics client", () => {
  it("every call no-ops before init", () => {
    track(EVENTS.scanStarted);
    identify("usr_1");
    resetAnalytics();
    captureException(new Error("x"));
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it("does not init without a key, and calls stay no-ops", () => {
    initAnalytics();
    expect(posthog.init).not.toHaveBeenCalled();
    track(EVENTS.scanStarted);
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("inits once with the key, then forwards calls", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    initAnalytics();
    initAnalytics();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/ingest",
        capture_exceptions: true,
        disable_session_recording: true,
      }),
    );
    track(EVENTS.creditsDepleted, { feature: "scan", required: 10, balance: 0 });
    expect(posthog.capture).toHaveBeenCalledWith("credits_depleted", {
      feature: "scan",
      required: 10,
      balance: 0,
    });
    identify("usr_1");
    expect(posthog.identify).toHaveBeenCalledWith("usr_1");
    resetAnalytics();
    expect(posthog.reset).toHaveBeenCalledOnce();
    const err = new Error("boom");
    captureException(err);
    expect(posthog.captureException).toHaveBeenCalledWith(err);
  });
});
