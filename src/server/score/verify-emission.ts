// One-off operator script — live 3/3 emission verification (spec 2026-07-14
// §4/§7): confirms gpt-oss-120b actually EMITS the Remote-Fit jd-extract
// facts (tzRequirement, hiringStructure, hiringScope, hiringCountries) from
// a JD that states all four, rather than silently omitting them the way
// jdFacts.ts's `.optional()` fields were found to (see extractJdFactsForGate's
// comment). Makes 3 REAL OpenRouter calls — COSTS REAL LLM MONEY (gpt-oss-120b
// jd-extract pricing per config/models.yml, a few cents total).
//
// Run: npm run remote-fit:verify-emission
//   (equivalent to: tsx --env-file-if-exists=.env.local src/server/score/verify-emission.ts)
import { fileURLToPath } from "node:url";
import { getLlm } from "@/lib/llm/client";
import { extractJdFactsForGate, type JdFactsGate } from "@/server/score/jdFacts";

const SAMPLE_JD = `Senior Backend Engineer — Globex Robotics

Globex Robotics is hiring a Senior Backend Engineer to join our platform team.
This is a fully remote position.

Schedule: This role requires 4 hours of daily overlap with PST for stand-ups
and pairing with the core engineering team.

Employment: Employment is via Deel as an Employer of Record (EOR) — you will
be employed by Deel on Globex Robotics's behalf, not as a direct employee or
independent contractor.

Hiring scope: We hire from the United States and Canada only for this role.

Responsibilities:
- Design and own backend services powering our robotics fleet dashboard
- Partner with the platform team on API design and reliability
- Mentor mid-level engineers

Requirements:
- 6+ years of backend engineering experience
- Strong TypeScript/Node.js background
- Experience with distributed systems

Salary: $150,000 - $190,000 USD/year.`;

const TARGET_FIELDS = ["tzRequirement", "hiringStructure", "hiringScope", "hiringCountries"] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

function isPresent(value: JdFactsGate[TargetField]): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export async function verifyEmission(): Promise<boolean> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — this script makes real OpenRouter calls and cannot run without it.",
    );
  }
  if (process.env.CALIBER_TEST_DOUBLES) {
    throw new Error(
      "verify-emission must NOT run with CALIBER_TEST_DOUBLES set — it verifies the REAL model's emission, not the mock.",
    );
  }

  const llm = getLlm();
  const passCounts: Record<TargetField, number> = {
    tzRequirement: 0,
    hiringStructure: 0,
    hiringScope: 0,
    hiringCountries: 0,
  };
  let totalCostUsd = 0;

  for (let run = 1; run <= 3; run++) {
    const { data, model, costUsd } = await extractJdFactsForGate(llm, SAMPLE_JD);
    totalCostUsd += costUsd;
    console.log(`\n--- run ${run}/3 (model: ${model}, cost: $${costUsd.toFixed(6)}) ---`);
    for (const field of TARGET_FIELDS) {
      const value = data[field];
      const present = isPresent(value);
      if (present) passCounts[field] += 1;
      console.log(`  ${field}: ${present ? "PRESENT" : "MISSING"} — ${JSON.stringify(value)}`);
    }
  }

  console.log("\n--- summary ---");
  let allPass = true;
  for (const field of TARGET_FIELDS) {
    const n = passCounts[field];
    console.log(`  ${field}: ${n}/3`);
    if (n < 3) allPass = false;
  }
  console.log(`  total cost: $${totalCostUsd.toFixed(6)}`);
  console.log(`\n${allPass ? "PASS" : "FAIL"} — ${allPass ? "all four fields present in all 3 runs" : "at least one field missing in at least one run"}`);
  return allPass;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyEmission()
    .then((allPass) => process.exit(allPass ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
