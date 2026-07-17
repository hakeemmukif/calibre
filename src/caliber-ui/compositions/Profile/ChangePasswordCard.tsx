"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { Input } from "../../components/Input";

export interface ChangePasswordCardProps {
  onSubmit(currentPassword: string, newPassword: string): void;
  busy: boolean;
  error?: string;
  success?: boolean;
}

// ChangePasswordCard — profile-page self-serve password change (Task 6,
// Decision 2). Mirrors AuthCard's controlled-Card idiom (kit Button is always
// type="button"; submit on click or Enter).
export function ChangePasswordCard({ onSubmit, busy, error, success }: ChangePasswordCardProps) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");

  function submit() {
    if (!current || next.length < 8 || busy) return;
    onSubmit(current, next);
  }

  return (
    <Card padding="lg" radius="lg" elevation="sm" style={{ maxWidth: 420, marginTop: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Change password</div>
        <Input
          label="Current password"
          type="password"
          value={current}
          disabled={busy}
          onChange={(e) => setCurrent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Input
          label="New password (min 8 characters)"
          type="password"
          value={next}
          disabled={busy}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && (
          <div
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--type-caption)", color: "var(--danger-ink)" }}
          >
            <Icon name="triangle-alert" size={14} />
            {error}
          </div>
        )}
        {success && (
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            Password changed. Other signed-in sessions were logged out.
          </div>
        )}
        <Button variant="primary" onClick={submit} disabled={busy || !current || next.length < 8}>
          {busy ? "Please wait…" : "Change password"}
        </Button>
      </div>
    </Card>
  );
}
