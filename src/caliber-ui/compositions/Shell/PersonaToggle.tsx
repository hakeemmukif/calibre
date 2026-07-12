"use client";
import * as React from "react";
import { Chip } from "../../components/Chip";
import type { Persona } from "../../../types";

export interface PersonaToggleProps {
  value: Persona;
  onChange(v: Persona): void;
  disabled?: boolean;
}

const OPTIONS: { value: Persona; label: string }[] = [
  { value: "remote", label: "Remote · global" },
  { value: "local", label: "Malaysia · local" },
  { value: "pasted", label: "Pasted" },
];

// PersonaToggle — segmented pill switching the active source-set/language
// preset (§11.2/§11.8). Composes two filter Chips; never its own control.
export function PersonaToggle({ value, onChange, disabled = false }: PersonaToggleProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 3,
        background: "var(--surface-sunken)",
        borderRadius: "var(--radius-pill, 999px)",
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : undefined,
      }}
    >
      {OPTIONS.map((opt) => (
        <Chip
          key={opt.value}
          variant="filter"
          selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
        >
          {opt.label}
        </Chip>
      ))}
    </div>
  );
}
