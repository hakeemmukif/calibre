import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { Job } from "@/types";
import { createGreenhouseConnector } from "./greenhouse";

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "greenhouse",
    name: "Greenhouse",
    kind: "ats",
    persona: "remote",
    enabled: true,
    config: { slug: "acme" },
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("greenhouse connector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the boards-api fixture payload to RawPosting[], using absolute_url as url", async () => {
    // `content` is a trimmed REAL escaped-HTML snippet, curled 2026-07-12 from
    // `boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true`.
    const fixture = {
      jobs: [
        {
          id: 123,
          title: "Senior Backend Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
          location: { name: "Remote" },
          first_published: "2026-06-01T00:00:00Z",
          content:
            "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab is the intelligent orchestration platform for DevSecOps. GitLab enables organizations to increase developer productivity, improve operational efficiency, reduce security and compliance risk, and accelerate digital transformation. More than 50 million registered users and more than 50% of the Fortune 100* trust GitLab to ship better, more secure software faster.&lt;/p&gt;&lt;/div&gt;",
        },
        { id: 456, title: "No URL Job", absolute_url: "" }, // dropped — no absolute_url
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const connector = createGreenhouseConnector(source());
    const onProgress = vi.fn();
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress }),
    );

    expect(postings).toEqual([
      {
        sourceId: "greenhouse",
        externalId: "123",
        url: "https://boards.greenhouse.io/acme/jobs/123",
        title: "Senior Backend Engineer",
        company: "acme",
        location: "Remote",
        description:
          "GitLab is the intelligent orchestration platform for DevSecOps. GitLab enables organizations to increase developer productivity, improve operational efficiency, reduce security and compliance risk, and accelerate digital transformation. More than 50 million registered users and more than 50% of the Fortune 100* trust GitLab to ship better, more secure software faster.",
        postedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("carries departments[0].name into RawPosting.department (P.4 tag input)", async () => {
    const fixture = {
      jobs: [
        {
          id: 321,
          title: "Eng",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/321",
          departments: [{ name: "Sales" }],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));
    const [posting] = await collect(
      createGreenhouseConnector(source()).discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );
    expect(posting.department).toBe("Sales");
  });

  it("caps the yielded description at 40_000 chars", async () => {
    const fixture = {
      jobs: [
        {
          id: 789,
          title: "Very Long Description",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/789",
          content: "&lt;p&gt;" + "x".repeat(45_000) + "&lt;/p&gt;",
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const connector = createGreenhouseConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toHaveLength(1);
    expect(postings[0].description).toHaveLength(40_000);
  });

  it("yields description undefined when content is absent or whitespace-only", async () => {
    const fixture = {
      jobs: [
        { id: 1, title: "No content field", absolute_url: "https://boards.greenhouse.io/acme/jobs/1" },
        { id: 2, title: "Whitespace content", absolute_url: "https://boards.greenhouse.io/acme/jobs/2", content: "   " },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const connector = createGreenhouseConnector(source());
    const postings = await collect(
      connector.discover({ targets: [], since: new Date(0), signal: new AbortController().signal, onProgress: () => {} }),
    );

    expect(postings).toHaveLength(2);
    expect(postings[0].description).toBeUndefined();
    expect(postings[1].description).toBeUndefined();
  });

  it("throws when the source has no config.slug", async () => {
    const connector = createGreenhouseConnector(source({ config: {} }));
    await expect(
      collect(
        connector.discover({
          targets: [],
          since: new Date(0),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/config\.slug/);
  });

  it("propagates a non-2xx response as a thrown error (caught by run.ts, not swallowed here)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const connector = createGreenhouseConnector(source());
    await expect(
      collect(
        connector.discover({
          targets: [],
          since: new Date(0),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  describe("extractQuestions (F4 tier 1)", () => {
    function job(applyUrl: string): Job {
      return {
        id: "job-1",
        score: 4,
        role: "Senior Backend Engineer",
        company: "Acme",
        meta: "Remote",
        verdict: "Apply",
        why: "x",
        tags: [],
        breakdown: [],
        fit: [],
        gaps: [],
        legitimacy: { tier: "clear", tone: "good", summary: "x" },
        eligibility: { tier: "unknown", tone: "warn", summary: "test fixture" },
        applyUrl,
        source: { id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote" },
        persona: "remote",
        firstSeen: new Date().toISOString(),
        isNew: false,
      };
    }

    it("maps the questions=true fixture to FormField[]", async () => {
      const fixture = {
        questions: [
          { label: "Why do you want to work here?", required: true, fields: [{ name: "value", type: "textarea" }] },
          {
            label: "How did you hear about us?",
            required: false,
            fields: [{ name: "value", type: "multi_value_single_select", values: [{ label: "LinkedIn" }, { label: "Referral" }] }],
          },
        ],
      };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const connector = createGreenhouseConnector(source());
      const fields = await connector.extractQuestions!(job("https://boards.greenhouse.io/acme/jobs/123456"));

      expect(fields).toEqual([
        { label: "Why do you want to work here?", field_type: "textarea", required: true },
        { label: "How did you hear about us?", field_type: "multi_value_single_select", required: false, options: ["LinkedIn", "Referral"] },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123456?questions=true",
        expect.anything(),
      );
    });

    it("returns null when the applyUrl carries no Greenhouse job id", async () => {
      const connector = createGreenhouseConnector(source());
      const fields = await connector.extractQuestions!(job("https://boards.greenhouse.io/acme/jobs"));
      expect(fields).toBeNull();
    });

    it("returns null (not a throw) on a non-2xx response, so the caller falls through to tier 2", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
      const connector = createGreenhouseConnector(source());
      const fields = await connector.extractQuestions!(job("https://boards.greenhouse.io/acme/jobs/123456"));
      expect(fields).toBeNull();
    });

    it("returns null when the source has no config.slug", async () => {
      const connector = createGreenhouseConnector(source({ config: {} }));
      const fields = await connector.extractQuestions!(job("https://boards.greenhouse.io/acme/jobs/123456"));
      expect(fields).toBeNull();
    });
  });
});
