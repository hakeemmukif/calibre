"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Chip } from "../../components/Chip";
import { Button } from "../../components/Button";
import type { Profile, SalaryCadence } from "../../../types";

export type JobTargetsFields = Pick<
  Profile,
  "displayLocation" | "targetRole" | "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryCadence"
>;

export interface JobTargetsProps {
  profile: Profile;
  busy: boolean;
  onSave(fields: JobTargetsFields): void;
}

const CURRENCY_OPTIONS = [
  { value: "", label: "Currency…" },
  { value: "MYR", label: "MYR" },
  { value: "USD", label: "USD" },
  { value: "SGD", label: "SGD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
];

const CADENCE_OPTIONS: { value: SalaryCadence; label: string }[] = [
  { value: "monthly", label: "Per month" },
  { value: "annual", label: "Per year" },
];

interface Draft {
  displayLocation: string;
  targetRole: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryCadence: SalaryCadence | null;
}

function toDraft(profile: Profile): Draft {
  return {
    displayLocation: profile.displayLocation ?? "",
    targetRole: profile.targetRole ?? "",
    salaryMin: profile.salaryMin?.toString() ?? "",
    salaryMax: profile.salaryMax?.toString() ?? "",
    salaryCurrency: profile.salaryCurrency ?? "",
    salaryCadence: profile.salaryCadence,
  };
}

// undefined = invalid input (blocks Save); null = intentionally empty.
function parseAmount(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function ProvenanceHint({ owner }: { owner: "resume" | "user" | undefined }) {
  if (!owner) return null;
  return (
    <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginLeft: 8 }}>
      {owner === "resume" ? "from résumé" : "edited"}
    </span>
  );
}

// Job targets card (spec 2026-07-22-resume-attributes-design.md §8): the
// résumé-seeded, user-editable attribute layer. Free-text fields use a
// draft + explicit Save (unlike the dial chips' save-on-change) so a
// half-typed salary never fires a PUT; the Save gate mirrors the server's
// salaryRules so a 422 is unreachable from here.
export function JobTargets({ profile, busy, onSave }: JobTargetsProps) {
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(profile));
  React.useEffect(() => setDraft(toDraft(profile)), [profile]);

  const min = parseAmount(draft.salaryMin);
  const max = parseAmount(draft.salaryMax);
  const hasAmount = (min ?? null) !== null || (max ?? null) !== null;
  const validationMessage =
    min === undefined || max === undefined
      ? "Salary amounts must be positive whole numbers."
      : typeof min === "number" && typeof max === "number" && min > max
        ? "Minimum salary must not exceed the maximum."
        : hasAmount && (!draft.salaryCurrency || !draft.salaryCadence)
          ? "Pick a currency and a cadence for the salary range."
          : null;

  const fields: JobTargetsFields | null = validationMessage
    ? null
    : {
        displayLocation: draft.displayLocation.trim() || null,
        targetRole: draft.targetRole.trim() || null,
        salaryMin: min ?? null,
        salaryMax: max ?? null,
        salaryCurrency: draft.salaryCurrency || null,
        salaryCadence: draft.salaryCadence,
      };

  const dirty =
    fields !== null &&
    (fields.displayLocation !== profile.displayLocation ||
      fields.targetRole !== profile.targetRole ||
      fields.salaryMin !== profile.salaryMin ||
      fields.salaryMax !== profile.salaryMax ||
      fields.salaryCurrency !== profile.salaryCurrency ||
      fields.salaryCadence !== profile.salaryCadence);

  return (
    <Card padding="md" radius="lg" elevation="sm" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>Job targets</div>
        <div>
          <Input
            label={
              <>
                Target role
                <ProvenanceHint owner={profile.attrProvenance.targetRole} />
              </>
            }
            placeholder="e.g. Backend Engineer"
            value={draft.targetRole}
            onChange={(e) => setDraft((d) => ({ ...d, targetRole: e.target.value }))}
            disabled={busy}
          />
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 6 }}>
            Scans match against this first, before your résumé's headline.
          </div>
        </div>
        <Input
          label={
            <>
              Location
              <ProvenanceHint owner={profile.attrProvenance.displayLocation} />
            </>
          }
          placeholder="e.g. Kuala Lumpur, Malaysia"
          value={draft.displayLocation}
          onChange={(e) => setDraft((d) => ({ ...d, displayLocation: e.target.value }))}
          disabled={busy}
        />
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
            Expected salary
            <ProvenanceHint owner={profile.attrProvenance.salary} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 8 }}>
            <Input
              placeholder="Min"
              inputMode="numeric"
              value={draft.salaryMin}
              onChange={(e) => setDraft((d) => ({ ...d, salaryMin: e.target.value }))}
              disabled={busy}
            />
            <Input
              placeholder="Max"
              inputMode="numeric"
              value={draft.salaryMax}
              onChange={(e) => setDraft((d) => ({ ...d, salaryMax: e.target.value }))}
              disabled={busy}
            />
            <Select
              value={draft.salaryCurrency}
              onChange={(e) => setDraft((d) => ({ ...d, salaryCurrency: e.target.value }))}
              options={CURRENCY_OPTIONS}
              disabled={busy}
            />
          </div>
          <div
            style={{
              display: "inline-flex",
              gap: 4,
              padding: 3,
              marginTop: 8,
              background: "var(--surface-sunken)",
              borderRadius: "var(--radius-pill, 999px)",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {CADENCE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                variant="filter"
                selected={draft.salaryCadence === opt.value}
                aria-pressed={draft.salaryCadence === opt.value}
                onClick={() => setDraft((d) => ({ ...d, salaryCadence: d.salaryCadence === opt.value ? null : opt.value }))}
                disabled={busy}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button variant="primary" disabled={busy || !dirty} onClick={() => fields && onSave(fields)}>
            Save targets
          </Button>
          {validationMessage && (
            <span style={{ font: "var(--type-caption)", color: "var(--danger-ink)" }}>{validationMessage}</span>
          )}
        </div>
      </div>
    </Card>
  );
}
