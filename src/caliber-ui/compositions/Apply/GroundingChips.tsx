"use client";
import { Chip } from "../../components/Chip";
import { Tag } from "../../components/Tag";
import type { ApplicationAnswer, Resume } from "../../../types";

export type GroundingItem = ApplicationAnswer["grounding"][number];

export interface GroundingChipsProps {
  grounding: ApplicationAnswer["grounding"];
  resume: Resume;
  selected?: GroundingItem;
  onSelect(item: GroundingItem): void;
}

// groundingLabel — turns a `{source, quote}` citation into the short region
// label §2's mock shows ("Summary", "Acme 2022–24 · bullet 3"). `experience`
// citations are matched against the résumé's own bullets so the label names
// the real company/role instead of a generic "Experience".
function groundingLabel(g: GroundingItem, resume: Resume): string {
  if (g.source === "summary") return "Summary";
  if (g.source === "skills") return "Skills";
  if (g.source === "headline") return "Headline";
  for (const exp of resume.experience) {
    const idx = exp.bullets.findIndex((b) => b.includes(g.quote) || g.quote.includes(b));
    if (idx >= 0) return `${exp.company} · bullet ${idx + 1}`;
  }
  return "Experience";
}

// GroundingChips — cites the résumé region(s) an answer draws from; clicking
// a chip opens ResumeRail to that source. Real contract: an answer the model
// couldn't ground returns with an EMPTY grounding array (api-contract §per
// endpoint /api/apply/answers) — that's the signal for the "not found in
// résumé" warn Tag, not a separate invented field.
export function GroundingChips({ grounding, resume, selected, onSelect }: GroundingChipsProps) {
  if (grounding.length === 0) {
    return (
      <Tag tone="warn">
        <span>Not found in résumé</span>
      </Tag>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>Grounded in:</span>
      {grounding.map((g, i) => (
        <Chip
          key={`${g.source}-${i}`}
          selected={selected === g}
          onClick={() => onSelect(g)}
          title={g.quote}
          iconLeft="link"
        >
          {groundingLabel(g, resume)}
        </Chip>
      ))}
    </div>
  );
}
