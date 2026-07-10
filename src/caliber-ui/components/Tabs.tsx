"use client";
import * as React from "react";

export interface TabItem {
  id: string;
  label: React.ReactNode;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  tabs?: TabItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
}

// Tabs — an underline tab strip. Controlled via activeId + onSelect.
export function Tabs({ tabs = [], activeId, onSelect, style, ...rest }: TabsProps) {
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", ...style }} {...rest}>
      {tabs.map((t) => {
        const on = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect && onSelect(t.id)}
            style={{
              position: "relative",
              padding: "10px 14px",
              marginBottom: -1,
              background: "none",
              border: "none",
              cursor: "pointer",
              font: "600 14px/1 var(--font-body)",
              color: on ? "var(--text-strong)" : "var(--text-muted)",
              borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              transition: "color var(--transition), border-color var(--transition)",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
