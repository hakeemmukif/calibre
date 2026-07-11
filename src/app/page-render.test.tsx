// Page-render smoke (task-B10-brief.md "Page render smoke: the app pages
// compile and render ... without runtime import errors; components consume
// ONLY features/*"). Each page's `useEffect` data-fetch never actually runs
// under `renderToStaticMarkup` (effects don't fire during a static render),
// so this intentionally does NOT hit the network/db — it proves imports
// resolve and the initial render (loading/idle state) doesn't throw, i.e.
// the wiring compiles and mounts. The route-level spine test (spine.test.ts)
// is what proves the data flow itself.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  useParams: () => ({ id: "job-1" }),
}));

async function renders(importPage: () => Promise<{ default: React.ComponentType }>): Promise<string> {
  const { default: Page } = await importPage();
  return renderToStaticMarkup(React.createElement(Page));
}

describe("app page render smoke", () => {
  it("/resume renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./resume/page"));
    expect(typeof html).toBe("string");
  });

  it("/feed renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./feed/page"));
    expect(html).toContain("Remote · global");
  });

  it("/jobs/[id] renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./jobs/[id]/page"));
    expect(typeof html).toBe("string");
  });

  it("/jobs/[id]/questions renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./jobs/[id]/questions/page"));
    expect(typeof html).toBe("string");
  });

  it("/jobs/[id]/tailor renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./jobs/[id]/tailor/page"));
    expect(typeof html).toBe("string");
  });

  it("/tracker renders its initial (loading) state without throwing", async () => {
    const html = await renders(() => import("./tracker/page"));
    expect(html).toContain("Application tracker");
  });
});
