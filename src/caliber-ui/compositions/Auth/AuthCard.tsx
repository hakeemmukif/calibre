"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export type AuthMode = "login" | "register";

export interface AuthCardProps {
  mode: AuthMode;
  onSubmit(email: string, password: string): void;
  busy: boolean;
  error?: string;
  switchHref: string;
  switchLabel: string;
}

const COPY: Record<AuthMode, { title: string; cta: string }> = {
  login: { title: "Sign in", cta: "Sign in" },
  register: { title: "Create your account", cta: "Create account" },
};

// AuthCard — the (auth) route group's login/register form (step-4 task-2).
// A plain controlled Card composition, mirroring UrlEvalBar's
// submit-on-click-or-Enter idiom (Button is always type="button", so there's
// no native <form> submit to hook into).
export function AuthCard({ mode, onSubmit, busy, error, switchHref, switchLabel }: AuthCardProps) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const { title, cta } = COPY[mode];

  function submit() {
    if (!email.trim() || !password || busy) return;
    onSubmit(email.trim(), password);
  }

  return (
    <Card padding="lg" radius="lg" elevation="sm" style={{ width: 360 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ font: "var(--type-h2)", color: "var(--text-strong)" }}>{title}</div>
        <Input
          label="Email"
          type="email"
          placeholder="you@example.com"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Input
          label="Password"
          type="password"
          placeholder="••••••••"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
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
        <Button variant="primary" fullWidth onClick={submit} disabled={busy}>
          {busy ? "Please wait…" : cta}
        </Button>
        <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", textAlign: "center" }}>
          <a href={switchHref} style={{ color: "var(--accent-ink)" }}>
            {switchLabel}
          </a>
        </div>
      </div>
    </Card>
  );
}
