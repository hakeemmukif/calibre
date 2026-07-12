"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import type { Profile, RelocationPref } from "../../../types";

export interface ProfileTargetsProps {
  profile: Profile;
  busy: boolean;
  onRelocationChange(v: RelocationPref): void;
}

const RELOCATION_OPTIONS: { value: RelocationPref; label: string }[] = [
  { value: "stay", label: "Stay in Malaysia" },
  { value: "open", label: "Open to relocate" },
];

// ProfileTargets — the /profile card (spec 2026-07-12 §7). Base country is a
// single-option Select (the honest extension point: a new country needs new
// local sources + token tables); relocation is a segmented pill mirroring
// PersonaToggle (two filter Chips in a sunken pill wrapper). Save-on-change
// is the PAGE's job — this stays a controlled composition.
export function ProfileTargets({ profile, busy, onRelocationChange }: ProfileTargetsProps) {
  return (
    <Card padding="md" radius="lg" elevation="sm">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Base country</div>
          <Select value={profile.baseCountry} onChange={() => {}} options={[{ value: "MY", label: "Malaysia" }]} />
        </div>
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Relocation</div>
          <div
            style={{
              display: "inline-flex",
              gap: 4,
              padding: 3,
              background: "var(--surface-sunken)",
              borderRadius: "var(--radius-pill, 999px)",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {RELOCATION_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={profile.relocation === opt.value}
                aria-pressed={profile.relocation === opt.value}
                onClick={() => onRelocationChange(opt.value)}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 8 }}>
            {profile.relocation === "stay"
              ? "Malaysia jobs + remote roles that hire from Malaysia."
              : "Also roles abroad that require relocating."}
          </div>
        </div>
      </div>
    </Card>
  );
}
