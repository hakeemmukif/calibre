import { describe, expect, it, vi } from "vitest";
import { verifyIdentity } from "./identity";

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

// Real shape of a lever board page (verified live 2026-07-17 against
// jobs.lever.co/porter): the org name is the <title>.
function leverBoard(name: string): Response {
  return html(`<!DOCTYPE html><html><head><title>${name} </title></head><body></body></html>`);
}

// Real shape of an ashby board page (verified live 2026-07-17 against
// jobs.ashbyhq.com/0g): the org identity is embedded in the bootstrap JSON.
function ashbyBoard(name: string, publicWebsite: string | null): Response {
  const site = publicWebsite === null ? "null" : `"${publicWebsite}"`;
  return html(
    `<!DOCTYPE html><html><head><title>${name} Jobs</title></head><body><script>window.__appData={"organization":{"organizationId":"13b668e9","name":"${name}","publicWebsite":${site},"customJobsPageUrl":null,"hostedJobsPageSlug":"x","activeFeatureFlags":["A"]},"jobBoard":{"teams":[{"id":"1","name":"GTM"}]}}</script></body></html>`,
  );
}

const noDelay = { politenessDelayMs: 0 };

describe("verifyIdentity", () => {
  describe("greenhouse", () => {
    it("confirms when the board API name matches the expected company", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { name: "Stripe", content: "" }));

      const verdict = await verifyIdentity(
        { name: "Stripe", slug: "stripe", ats: "greenhouse", companyDomain: "stripe.com", matchMethod: "domain-stem" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("confirmed");
      expect(verdict).toMatchObject({ evidence: expect.stringContaining("Stripe") });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://boards-api.greenhouse.io/v1/boards/stripe",
        expect.anything(),
      );
    });

    it("accepts real spelling variance: expected 'Stripe' vs vendor 'Stripe, Inc.'", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { name: "Stripe, Inc.", content: "" }));

      const verdict = await verifyIdentity(
        { name: "Stripe", slug: "stripe", ats: "greenhouse", companyDomain: "stripe.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("confirmed");
    });

    // The real mis-attribution found by the live probe: jobhive's greenhouse
    // slug "affinity" is "Affinity.co", but the YC company named "Affinity" is
    // itsaffinity.com. Different companies — seeding this feeds one company's
    // jobs to people searching for another.
    it("REAL CASE: rejects greenhouse 'Affinity.co' against YC 'Affinity' (itsaffinity.com)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { name: "Affinity.co", content: "" }));

      const verdict = await verifyIdentity(
        {
          name: "Affinity",
          slug: "affinity",
          ats: "greenhouse",
          companyDomain: "itsaffinity.com",
          matchMethod: "name",
        },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("mismatch");
      expect(verdict).toMatchObject({ evidence: expect.stringContaining("Affinity.co") });
    });

    it("treats a missing name field as unverifiable, never as confirmed", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { content: "" }));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "greenhouse", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "no_identity_field" });
    });
  });

  describe("lever", () => {
    // Verified live 2026-07-17: the v0 postings API carries NO org identity
    // (keys are text/categories/hostedUrl/... only), but the public board page
    // https://jobs.lever.co/{slug} does — as its <title>. robots.txt allows it
    // (User-agent: * / Allow: /).
    it("confirms from the board page <title>", async () => {
      const fetchMock = vi.fn().mockResolvedValue(leverBoard("15Five"));

      const verdict = await verifyIdentity(
        { name: "15Five", slug: "15five", ats: "lever", companyDomain: "15five.com", matchMethod: "domain-stem" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("confirmed");
      expect(fetchMock).toHaveBeenCalledWith("https://jobs.lever.co/15five", expect.anything());
    });

    // The second real mis-attribution from the probe.
    it("REAL CASE: rejects lever 'Porter Cares, Inc.' against YC 'Porter' (porter.run)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(leverBoard("Porter Cares, Inc."));

      const verdict = await verifyIdentity(
        { name: "Porter", slug: "porter", ats: "lever", companyDomain: "porter.run", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("mismatch");
      expect(verdict).toMatchObject({ evidence: expect.stringContaining("Porter Cares, Inc.") });
    });

    it("treats a board page with no <title> as unverifiable", async () => {
      const fetchMock = vi.fn().mockResolvedValue(html("<html><head></head><body>hi</body></html>"));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "lever", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "no_identity_field" });
    });
  });

  describe("ashby", () => {
    // Verified live 2026-07-17: the posting-api payload has no org-name field
    // (top-level keys are exactly `jobs, apiVersion`), and /api/ is
    // robots-disallowed on jobs.ashbyhq.com — but the board PAGE embeds
    // {"organization":{"name":...,"publicWebsite":...}} and is allowed.
    it("confirms from the embedded organization.name", async () => {
      const fetchMock = vi.fn().mockResolvedValue(ashbyBoard("0g Labs", "https://0g.ai/"));

      const verdict = await verifyIdentity(
        { name: "0g Labs", slug: "0g", ats: "ashby", companyDomain: "0g.ai", matchMethod: "domain-stem" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("confirmed");
      expect(fetchMock).toHaveBeenCalledWith("https://jobs.ashbyhq.com/0g", expect.anything());
    });

    it("confirms on publicWebsite domain even when the name reads differently", async () => {
      const fetchMock = vi.fn().mockResolvedValue(ashbyBoard("0g Labs", "https://www.0g.ai/careers"));

      const verdict = await verifyIdentity(
        { name: "0g", slug: "0g", ats: "ashby", companyDomain: "0g.ai", matchMethod: "domain-stem" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toMatchObject({ status: "confirmed", evidence: expect.stringContaining("0g.ai") });
    });

    // Third head of the same real collision: jobhive's ashby "affinity" is
    // "Affinity Analytics" — also not YC's Affinity.
    it("REAL CASE: rejects ashby 'Affinity Analytics' against YC 'Affinity' (itsaffinity.com)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(ashbyBoard("Affinity Analytics", null));

      const verdict = await verifyIdentity(
        { name: "Affinity", slug: "affinity", ats: "ashby", companyDomain: "itsaffinity.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict.status).toBe("mismatch");
    });

    it("treats a board page with no organization block as unverifiable", async () => {
      const fetchMock = vi.fn().mockResolvedValue(html("<html><head><title>Acme Jobs</title></head><body></body></html>"));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "ashby", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "no_identity_field" });
    });
  });

  describe("name comparison rule", () => {
    it.each([
      ["Stripe", "Stripe"],
      ["Stripe", "Stripe, Inc."],
      ["Stripe", "stripe inc"],
      ["Deel", "Deel, Inc"],
      ["Alan", "Alan SAS"],
      ["Personio", "Personio GmbH"],
      ["Canva", "Canva Pty Ltd"],
      ["Monzo", "Monzo Bank Limited"], // "Bank" is not a legal suffix -> stays
    ])("accepts expected %s vs vendor %s", async (expected, vendor) => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { name: vendor }));
      const verdict = await verifyIdentity(
        { name: expected, slug: "s", ats: "greenhouse", companyDomain: "x.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );
      // "Monzo Bank Limited" -> "monzobank" != "monzo": documented as a
      // deliberate false-mismatch (conservative direction).
      expect(verdict.status).toBe(expected === "Monzo" ? "mismatch" : "confirmed");
    });

    it.each([
      ["Affinity", "Affinity.co"],
      ["Affinity", "Affinity Analytics"],
      ["Porter", "Porter Cares, Inc."],
      ["Ramp", "Ramp Network"],
      ["Scale", "Scale Computing"],
    ])("rejects expected %s vs vendor %s", async (expected, vendor) => {
      const fetchMock = vi.fn().mockResolvedValue(json(200, { name: vendor }));
      const verdict = await verifyIdentity(
        { name: expected, slug: "s", ats: "greenhouse", companyDomain: "x.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );
      expect(verdict.status).toBe("mismatch");
    });
  });

  describe("politeness (design §7)", () => {
    it("403 -> unverifiable, not retried", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(403, {}));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "lever", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "forbidden" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("429 -> unverifiable, not retried", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(429, {}));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "ashby", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "rate_limited" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("404 -> unverifiable (board is gone; identity cannot be established)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(404, {}));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "greenhouse", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "not_found" });
    });

    it("a rejected fetch -> unverifiable, never thrown", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

      const verdict = await verifyIdentity(
        { name: "Acme", slug: "acme", ats: "greenhouse", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      );

      expect(verdict).toEqual({ status: "unverifiable", reason: "network_error: ECONNRESET" });
    });

    it("caps in-flight requests per host at 2 and does not leak slots when fetches reject", async () => {
      const inFlight: Record<string, number> = {};
      const maxSeen: Record<string, number> = {};

      const fetchMock = vi.fn(async (url: string) => {
        const host = new URL(url).host;
        inFlight[host] = (inFlight[host] ?? 0) + 1;
        maxSeen[host] = Math.max(maxSeen[host] ?? 0, inFlight[host]);
        await new Promise((r) => setTimeout(r, 5));
        inFlight[host] -= 1;
        if (url.includes("reject-me")) throw new Error("timeout");
        return json(200, { name: "Acme" });
      });

      const candidates = [
        "reject-me-1",
        "reject-me-2",
        "reject-me-3",
        "acme-1",
        "acme-2",
        "acme-3",
      ].map((slug) => ({
        name: "Acme",
        slug,
        ats: "greenhouse" as const,
        companyDomain: "acme.com",
        matchMethod: "name" as const,
      }));

      const verdicts = await Promise.all(
        candidates.map((c) => verifyIdentity(c, { fetch: fetchMock, ...noDelay })),
      );

      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(verdicts).toHaveLength(6);
      expect(maxSeen["boards-api.greenhouse.io"]).toBeLessThanOrEqual(2);
      expect(verdicts.slice(0, 3).every((v) => v.status === "unverifiable")).toBe(true);
      expect(verdicts.slice(3).every((v) => v.status === "confirmed")).toBe(true);
    });
  });

  it("rejects an unknown ats kind loudly", async () => {
    const fetchMock = vi.fn();
    await expect(
      verifyIdentity(
        // @ts-expect-error — deliberately invalid ats to assert the fail-loud boundary
        { name: "Acme", slug: "acme", ats: "workday", companyDomain: "acme.com", matchMethod: "name" },
        { fetch: fetchMock, ...noDelay },
      ),
    ).rejects.toThrow(/workday/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
