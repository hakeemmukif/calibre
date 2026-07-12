// Deterministic connector for the CALIBER_TEST_DOUBLES seam (getLlm's peer
// for search). Mirrors spine.test.ts's stubConnector: one posting per
// source id, same "Senior Backend Engineer, Payments" universe so
// roleFuzzyMatch passes against the scripted résumé.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";

const POSTINGS: Record<string, RawPosting> = {
  greenhouse: {
    sourceId: "greenhouse",
    url: "https://boards.greenhouse.io/grab/jobs/6041234",
    title: "Senior Backend Engineer, Payments",
    company: "Grab",
    location: "Remote",
    description: "Own the payments ledger service. Stack: Node.js, Kafka, Postgres. Payments domain experience valued.",
  },
  jobstreet: {
    sourceId: "jobstreet",
    url: "https://www.jobstreet.com.my/job/senior-backend-engineer-payments-991234",
    title: "Senior Backend Engineer, Payments",
    company: "Local Fintech Sdn Bhd",
    location: "Kuala Lumpur, Malaysia",
    description: "Build the merchant payments platform. Stack: Node.js, Postgres. Payments domain experience valued.",
  },
  // The e2e abroad case (spec §8 journey): New York onsite on a
  // restricted-prior source classifies `abroad` — hidden under relocation
  // "stay", revealed under "open".
  lever: {
    sourceId: "lever",
    url: "https://jobs.lever.co/acme/senior-backend-engineer-payments",
    title: "Senior Backend Engineer, Payments",
    company: "Acme US",
    location: "New York, NY",
    description: "Payments platform team. Stack: Node.js, Postgres. Onsite in New York. Payments domain experience valued.",
  },
};

export function createFixtureConnector(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover() {
      const posting = POSTINGS[source.id];
      if (posting) yield posting;
    },
  };
}
