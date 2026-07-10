"use client";
import * as React from "react";
import { PersonaToggle } from "./PersonaToggle";
import { UrlEvalBar, type UrlEvalStatus } from "./UrlEvalBar";
import { NotificationBell } from "./NotificationBell";
import type { Persona } from "../../../types";

export interface AppShellHeaderProps {
  persona: Persona;
  onPersona(v: Persona): void;
  evalStatus: UrlEvalStatus;
  onEval(url: string): void;
  alertCount: number;
}

// AppShellHeader — §11.8 top row: PersonaToggle · UrlEvalBar · NotificationBell.
export function AppShellHeader({ persona, onPersona, evalStatus, onEval, alertCount }: AppShellHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "16px 24px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <PersonaToggle value={persona} onChange={onPersona} />
      </div>
      <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
        <UrlEvalBar status={evalStatus} onSubmit={onEval} />
      </div>
      <NotificationBell count={alertCount} />
    </header>
  );
}
