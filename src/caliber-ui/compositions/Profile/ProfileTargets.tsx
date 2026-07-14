"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import type { Profile, RelocationPref, ScheduleFlex, EmploymentPref } from "../../../types";

export interface ProfileTargetsProps {
  profile: Profile;
  busy: boolean;
  onRelocationChange(v: RelocationPref): void;
  onScheduleChange(v: ScheduleFlex): void;
  onEmploymentChange(v: EmploymentPref): void;
  onPresetSelect(dials: { relocation: RelocationPref; scheduleFlex: ScheduleFlex; employmentPref: EmploymentPref }): void;
}

const RELOCATION_OPTIONS: { value: RelocationPref; label: string }[] = [
  { value: "stay", label: "Stay in Malaysia" },
  { value: "open", label: "Open to relocate" },
];

const SCHEDULE_OPTIONS: { value: ScheduleFlex; label: string }[] = [
  { value: "base-hours", label: "Malaysia hours" },
  { value: "flex-evenings", label: "Evenings OK — Europe overlap" },
  { value: "any-hours", label: "Any hours — US overlap" },
];

const EMPLOYMENT_OPTIONS: { value: EmploymentPref; label: string }[] = [
  { value: "any", label: "Any arrangement" },
  { value: "employee", label: "Employee — EOR OK" },
  { value: "local-entity", label: "Malaysian entity only" },
];

const PRESETS = [
  { key: "my-remote", label: "Malaysia-only remote", dials: { relocation: "stay", scheduleFlex: "base-hours", employmentPref: "local-entity" } },
  { key: "global", label: "Global remote", dials: { relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" } },
  { key: "nomad", label: "Digital nomad", dials: { relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" } },
  { key: "relocate", label: "Open to relocate", dials: { relocation: "open", scheduleFlex: "flex-evenings", employmentPref: "any" } },
] as const satisfies readonly {
  key: string;
  label: string;
  dials: { relocation: RelocationPref; scheduleFlex: ScheduleFlex; employmentPref: EmploymentPref };
}[];

// ProfileTargets — the /profile card (spec 2026-07-14 §8). Base country is a
// single-option Select (the honest extension point: a new country needs new
// local sources + token tables); relocation/schedule/employment are segmented
// pills mirroring PersonaToggle (filter Chips in a sunken pill wrapper). The
// preset row sets all three dials at once — presets are not stored state,
// the dials remain the only truth. Save-on-change is the PAGE's job — this
// stays a controlled composition.
export function ProfileTargets({
  profile,
  busy,
  onRelocationChange,
  onScheduleChange,
  onEmploymentChange,
  onPresetSelect,
}: ProfileTargetsProps) {
  return (
    <Card padding="md" radius="lg" elevation="sm">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
            Which sounds like you?
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {PRESETS.map((preset) => (
              <Card
                key={preset.key}
                interactive={!busy}
                role="button"
                aria-label={`Preset: ${preset.label}`}
                aria-disabled={busy}
                tabIndex={busy ? -1 : 0}
                onClick={() => {
                  if (!busy) onPresetSelect(preset.dials);
                }}
                onKeyDown={(e) => {
                  if (busy) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPresetSelect(preset.dials);
                  }
                }}
                padding="sm"
                radius="md"
                elevation="none"
                style={{
                  flex: "1 1 160px",
                  textAlign: "center",
                  font: "var(--type-body)",
                  color: "var(--text-body)",
                  opacity: busy ? 0.5 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {preset.label}
              </Card>
            ))}
          </div>
        </div>
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
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Schedule</div>
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
            {SCHEDULE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={profile.scheduleFlex === opt.value}
                aria-pressed={profile.scheduleFlex === opt.value}
                onClick={() => onScheduleChange(opt.value)}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>Employment</div>
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
            {EMPLOYMENT_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={profile.employmentPref === opt.value}
                aria-pressed={profile.employmentPref === opt.value}
                onClick={() => onEmploymentChange(opt.value)}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
