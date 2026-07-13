"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import type { Profile, RelocationPref, ScheduleFlex, EmploymentPref } from "../../../types";

export type ProfileDialsBundle = Pick<Profile, "relocation" | "scheduleFlex" | "employmentPref">;

export interface ProfileTargetsProps {
  profile: Profile;
  busy: boolean;
  onRelocationChange(v: RelocationPref): void;
  onScheduleChange(v: ScheduleFlex): void;
  onEmploymentChange(v: EmploymentPref): void;
  onPresetSelect(bundle: ProfileDialsBundle): void;
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

// Preset→dial bundles (spec 2026-07-14-remote-fit-criteria-design.md §8).
// Presets are NOT stored — a tile fires onPresetSelect with the bundle, and
// the page does ONE PUT of all four fields. Nothing about the preset itself
// persists; "selected" below is derived from the current dials each render.
const PRESETS: { name: string; dials: ProfileDialsBundle }[] = [
  { name: "Malaysia-only remote", dials: { relocation: "stay", scheduleFlex: "base-hours", employmentPref: "local-entity" } },
  { name: "Global remote", dials: { relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" } },
  { name: "Digital nomad", dials: { relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" } },
  { name: "Open to relocate", dials: { relocation: "open", scheduleFlex: "flex-evenings", employmentPref: "any" } },
];

function labelFor<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

// ProfileTargets — the /profile card (spec 2026-07-12 §7, extended by
// 2026-07-14-remote-fit-criteria-design.md §8). Base country is a
// single-option Select (the honest extension point: a new country needs new
// local sources + token tables); relocation/schedule/employment are
// segmented pills mirroring PersonaToggle (filter Chips in a sunken pill
// wrapper). The preset row on top sets all three dials via a single
// onPresetSelect call — save-on-change is the PAGE's job, this stays a
// controlled composition.
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            {PRESETS.map((preset) => {
              const selected =
                profile.relocation === preset.dials.relocation &&
                profile.scheduleFlex === preset.dials.scheduleFlex &&
                profile.employmentPref === preset.dials.employmentPref;
              return (
                <Card
                  key={preset.name}
                  interactive
                  role="button"
                  tabIndex={busy ? -1 : 0}
                  aria-pressed={selected}
                  aria-disabled={busy}
                  padding="sm"
                  radius="md"
                  onClick={() => {
                    if (busy) return;
                    onPresetSelect(preset.dials);
                  }}
                  onKeyDown={(e) => {
                    if (busy) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPresetSelect(preset.dials);
                    }
                  }}
                  style={{
                    border: selected ? "1.5px solid var(--text-strong)" : undefined,
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <div style={{ font: "600 13px/1.3 var(--font-body)", color: "var(--text-strong)" }}>{preset.name}</div>
                  <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>
                    {labelFor(RELOCATION_OPTIONS, preset.dials.relocation)} ·{" "}
                    {labelFor(SCHEDULE_OPTIONS, preset.dials.scheduleFlex)} ·{" "}
                    {labelFor(EMPLOYMENT_OPTIONS, preset.dials.employmentPref)}
                  </div>
                </Card>
              );
            })}
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
