// Curated role-synonym table — the big recall lever measured in
// docs/superpowers/reports/2026-07-17-matching-tiers.md §4 (recall 0.722 → 0.894,
// FP 141 → 187 over the 2,008-pair labeled real corpus). Alias expansion runs at
// `deriveRoleTargets`: for each résumé, if a trigger matches the résumé's own
// titles, its alias titles are emitted ALONGSIDE them, so `roleFuzzyMatch` then
// runs unchanged against a wider title set. This is pure vocabulary — the geometry
// (phrase/head-noun/Jaccard) is untouched.
//
// EVERY alias below is quoted from a real posting title on the 15 seeded ATS
// boards (Stripe/Airwallex/GitLab/Bjak/…); the corpus source is named in each
// rule's comment. Do NOT add a synonym the corpus does not carry — the table is
// fitted to these boards and does not transfer unmeasured (§11).
//
// Split by product risk:
//   STRICT  — same role, different name. Always-on.
//   SIBLING — same function, different specialization/grade. The deliberate
//             "widen the net" choice; its FPs are concentrated in ops and are
//             largely oracle under-counts (§4/§7).
//
// TRIGGER HYGIENE — the report FOUND AND FIXED two trigger bugs during
// measurement (§4); the guards below encode the fixes, do not remove them:
//   1. `/operations manager/` fired on "People Operations Manager" and would have
//      handed HR résumés the ops expansion (+56 people-FPs) → guarded with a
//      `(?<!people )` negative lookbehind.
//   2. `/marketing manager/` fired on "Content Marketing Manager" and would have
//      handed a content-specialist résumé the whole generalist marketing
//      expansion (+72 FP) → guarded with a `(?<!content )` negative lookbehind.
// Any new trigger needs the same word-boundary + negative-context care.

export interface RoleSynonymRule {
  trigger: RegExp;
  aliases: string[];
}

// STRICT: same role, different name on these boards. 10 rules / 19 aliases.
export const ROLE_SYNONYMS_STRICT: RoleSynonymRule[] = [
  // "Talent Acquisition Partner" (Airwallex ×8), "Talent Acquisition Specialist"
  // (Toptal/Bjak), "Head of Talent Acquisition" (Bjak), "Sr. Technical Sourcer"
  // (Perplexity), "Senior Recruiter | Design" (Ramp), "Operations Recruiter" (ElevenLabs)
  { trigger: /recruiter/i, aliases: ["Talent Acquisition", "Sourcer", "Recruiter"] },
  // "Corporate Accounting" (Stripe), "Financial Accounting" (ElevenLabs),
  // "International Accounting Lead" (Stripe)
  { trigger: /accountant/i, aliases: ["Accounting"] },
  // "Engineering Lead, Billing" (Airwallex ×10), "IT Engineering Lead" (ElevenLabs)
  { trigger: /engineering manager/i, aliases: ["Engineering Lead"] },
  // "Solutions Architect" (GitLab ×11), "Partner Solutions Architect - AWS" (Stripe)
  { trigger: /(solutions?|sales) engineer/i, aliases: ["Solutions Architect"] },
  // "Business Development Representative - Enterprise" (Plaid),
  // "Sales Development - DACH" (ElevenLabs ×9)
  { trigger: /sales development representative|\bsdr\b/i, aliases: ["Business Development Representative", "Sales Development"] },
  // "Sales Executive, Enterprise Accounts" (Airwallex), "Enterprise Sales
  // Executive" (Toptal), "Inbound Sales Representative, Japan" (Airwallex),
  // "Client Sales Representative" (Toptal)
  { trigger: /account executive/i, aliases: ["Sales Executive", "Sales Representative"] },
  // "Commercial Counsel" (Stripe), "IP Counsel" (ElevenLabs), "Regulatory
  // Counsel, EMEA" (Airwallex), "Corporate Paralegal" (Stripe)
  { trigger: /(legal|corporate) counsel/i, aliases: ["Counsel", "Paralegal"] },
  // "Manager, Regulatory Compliance, Vietnam" (Airwallex), "Japan Regulatory
  // Compliance & Money Laundering Reporting Officer" (Stripe)
  { trigger: /compliance (manager|officer)/i, aliases: ["Regulatory Compliance", "Money Laundering"] },
  // "Risk Operations Analyst - SSO" (Stripe), "Risk Strategist, Onboarding and
  // Compliance" (Stripe), "Senior Manager, Risk Operations Strategy" (Airwallex)
  { trigger: /risk (analyst|manager)/i, aliases: ["Risk Operations", "Risk Strategist"] },
  // "People Partner" (Stripe), "(Senior) People Operations Partner, ANZ"
  // (Airwallex), "Lead, HR Operations" (Bjak)
  { trigger: /people operations|hr manager|hr business partner/i, aliases: ["People Partner", "People Operations", "HR Operations"] },
];

// SIBLING: same function, different specialization or grade (corpus-present).
// 8 rules / 38 aliases.
export const ROLE_SYNONYMS_SIBLING: RoleSynonymRule[] = [
  // "Brand Designer" (Supabase/Bjak), "Graphic Designer - Freelance" (Bjak),
  // "Visual Designer" (Bjak), "Interaction Designer, HCI" (Bjak),
  // "Member of Creative Studio (Web Designer - ...)" (Perplexity)
  { trigger: /(product|ux) designer/i, aliases: ["Brand Designer", "Graphic Designer", "Visual Designer", "Interaction Designer", "Web Designer"] },
  // "Head of Product Marketing" (Plaid), "Director, Global Performance
  // Marketing" (Airwallex), "Senior Manager, Growth Marketing, ..." (Airwallex),
  // "Brand Marketing" (ElevenLabs), "Senior Manager, Field Marketing, SEA"
  // (Airwallex), "B2B Marketing - ANZ" (ElevenLabs), "Senior Manager, Field &
  // Partner Marketing" (Airwallex), "Customer Marketing Associate" (Plaid),
  // "Digital Marketing Executive" (Bjak), "Campaign Marketing Specialist (ANZ
  // market)" (ShopBack), "Marketing Associate" (ShopBack), "Senior Marketing
  // Analyst, Strategy & Analytics" (Toptal), "Contract Marketing Coordinator"
  // (ShopBack)
  // generalist marketing résumés only — "Content Marketing Manager" is itself a
  // specialization and must not inherit the generalist expansion (trigger bug §4)
  { trigger: /(?<!content )marketing manager/i, aliases: ["Product Marketing", "Performance Marketing", "Growth Marketing", "Brand Marketing", "Field Marketing", "B2B Marketing", "Partner Marketing", "Customer Marketing", "Marketing Executive", "Marketing Specialist", "Marketing Associate", "Marketing Analyst", "Marketing Coordinator"] },
  // "Customer Success Architect" (GitLab ×4), "Customer Success Engineer, EMEA"
  // (GitLab), "Customer Success Lead - UK/I" (ElevenLabs)
  { trigger: /customer success manager/i, aliases: ["Customer Success"] },
  // "Analyst, Customer Support" (Airwallex), "Product Support Specialist"
  // (Stripe), "Technical Support Lead" (Airwallex), "IT Support" (ElevenLabs),
  // "Support Engineer, U.S. Government Support" (GitLab)
  { trigger: /(customer|technical) support/i, aliases: ["Customer Support", "Product Support", "Technical Support", "IT Support", "Support Engineer"] },
  // "Bridge Operations Associate" (Stripe), "Treasury Operations Specialist"
  // (Stripe), "Monetization Operations Analyst" (Stripe), "Strategy &
  // Operations Associate" (Bjak)
  // NOT for "People Operations Manager" résumés (trigger bug §4)
  { trigger: /(?<!people )operations manager/i, aliases: ["Operations Associate", "Operations Specialist", "Operations Analyst", "Strategy Operations"] },
  // "Director, Strategic Partnerships" (GitLab), "Senior Manager, Financial
  // Partnerships, ..." (Airwallex ×4), "Revenue Partnerships" (ElevenLabs ×7),
  // "Director, Channel Partnerships, ..." (Airwallex), "Brand Partnership
  // Manager" (Bjak)
  { trigger: /partnerships? manager|business development manager/i, aliases: ["Strategic Partnerships", "Financial Partnerships", "Revenue Partnerships", "Channel Partnerships", "Partnerships"] },
  // "UGC Content Creator (TikTok/Reels/Shorts)" (Bjak), "Content Lead" (Plaid),
  // "Content Storyteller" (Bjak)
  { trigger: /content (writer|marketing)/i, aliases: ["Content Creator", "Content Lead", "Content Storyteller"] },
  // "Credit Risk Strategy Manager" (Stripe), "Fraud Operations Manager" (Stripe)
  { trigger: /risk (analyst|manager)/i, aliases: ["Credit Risk", "Fraud Operations"] },
];

/**
 * Emits the résumé's own titles PLUS alias titles for every rule whose trigger
 * matches (tested against the titles joined by " | ", so a trigger only fires on
 * the résumé's actual titles). Strict runs before sibling; both are always-on.
 * Order-independent — the caller (`roleFuzzyMatch`) is `titles.some(...)`.
 */
export function expandRoleTitles(titles: string[]): string[] {
  const joined = titles.join(" | ");
  const out = [...titles];
  for (const rule of [...ROLE_SYNONYMS_STRICT, ...ROLE_SYNONYMS_SIBLING]) {
    if (rule.trigger.test(joined)) {
      for (const alias of rule.aliases) if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
}
