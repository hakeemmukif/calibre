"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export interface FinishSetupValues {
  targetRole: string | null;
  displayLocation: string | null;
}

export interface FinishSetupCardProps {
  needsTargetRole: boolean;
  needsLocation: boolean;
  busy: boolean;
  error?: string;
  onSubmit(values: FinishSetupValues): void;
}

// Post-upload gap-filler (spec 2026-07-22-resume-attributes-design.md §8):
// renders ONLY the missing scan attributes. Target role is the scan gate;
// location is an optional rider. Values land on the profile via the page.
export function FinishSetupCard({ needsTargetRole, needsLocation, busy, error, onSubmit }: FinishSetupCardProps) {
  const [targetRole, setTargetRole] = React.useState("");
  const [location, setLocation] = React.useState("");
  const canSave = !needsTargetRole || targetRole.trim().length > 0;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Finish setting up your scan</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            Your résumé is saved — it just didn't state everything scanning needs. Fill the gaps below (editable later in
            Profile &amp; targets).
          </div>
        </div>
        {needsTargetRole && (
          <Input
            label="What kind of job are you looking for?"
            placeholder="e.g. Backend Engineer"
            value={targetRole}
            onChange={(e) => setTargetRole(e.target.value)}
            disabled={busy}
          />
        )}
        {needsLocation && (
          <Input
            label="Where are you based? (optional)"
            placeholder="e.g. Kuala Lumpur, Malaysia"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            disabled={busy}
          />
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger-ink)" }}>
            <Icon name="triangle-alert" size={16} />
            <span style={{ font: "var(--type-caption)" }}>{error}</span>
          </div>
        )}
        <div>
          <Button
            variant="primary"
            disabled={busy || !canSave}
            onClick={() => onSubmit({ targetRole: targetRole.trim() || null, displayLocation: location.trim() || null })}
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
