"use client";
import * as React from "react";
import { Icon } from "./Icon";

export interface NavItem {
  id?: string;
  label?: React.ReactNode;
  /** Lucide-style icon name. */
  icon?: string;
  count?: number | null;
  /** When set, this entry renders as a group header instead of a link. */
  section?: string;
}

export interface SidebarNavProps extends Omit<React.HTMLAttributes<HTMLElement>, "onSelect"> {
  brand?: string;
  logoSrc?: string;
  items?: NavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  footer?: React.ReactNode;
}

// SidebarNav — the app's primary navigation. Accepts a flat item list where
// `{ section }` entries become group headers and the rest are nav rows with an
// icon, label, and optional count. Active row gets the accent tint.
export function SidebarNav({
  brand = "Caliber",
  logoSrc,
  items = [],
  activeId,
  onSelect,
  footer,
  style,
  ...rest
}: SidebarNavProps) {
  return (
    <nav
      style={{
        width: "var(--sidebar-w)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        padding: "20px 14px 16px",
        ...style,
      }}
      {...rest}
    >
      {/* brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 18px" }}>
        {logoSrc ? (
          <img src={logoSrc} alt="" style={{ width: 28, height: 28, borderRadius: 7 }} />
        ) : (
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--text-strong)",
              color: "var(--surface)",
              display: "grid",
              placeItems: "center",
              font: "700 15px/1 var(--font-display)",
            }}
          >
            {brand[0]}
          </span>
        )}
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          {brand}
        </span>
      </div>

      {/* items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, overflow: "auto" }}>
        {items.map((it, i) => {
          if (it.section) {
            return (
              <div
                key={`s${i}`}
                style={{
                  font: "var(--type-eyebrow)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-caps)",
                  color: "var(--text-faint)",
                  padding: "14px 9px 5px",
                }}
              >
                {it.section}
              </div>
            );
          }
          return <NavRow key={it.id ?? `row-${i}`} item={it} active={it.id === activeId} onSelect={onSelect} />;
        })}
      </div>

      {footer && <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-faint)" }}>{footer}</div>}
    </nav>
  );
}

interface NavRowProps {
  item: NavItem;
  active: boolean;
  onSelect?: (id: string) => void;
}

function NavRow({ item, active, onSelect }: NavRowProps) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => item.id != null && onSelect?.(item.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        textAlign: "left",
        padding: "9px 10px",
        borderRadius: "var(--radius-sm)",
        border: "none",
        cursor: "pointer",
        background: active ? "var(--accent-soft)" : hover ? "var(--surface-sunken)" : "transparent",
        color: active ? "var(--accent-ink)" : "var(--text-body)",
        font: `${active ? 600 : 500} 14px/1 var(--font-body)`,
        transition: "background var(--transition), color var(--transition)",
      }}
    >
      {item.icon && (
        <Icon
          name={item.icon}
          size={18}
          strokeWidth={active ? 2.2 : 2}
          style={{ color: active ? "var(--accent-ink)" : "var(--text-muted)" }}
        />
      )}
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
      {item.count != null && (
        <span
          style={{
            font: "600 11.5px/1 var(--font-body)",
            fontVariantNumeric: "tabular-nums",
            color: active ? "var(--accent-ink)" : "var(--text-muted)",
            background: active ? "transparent" : "var(--surface-sunken)",
            borderRadius: "var(--radius-pill, 999px)",
            padding: active ? 0 : "3px 7px",
            minWidth: 8,
            textAlign: "center",
          }}
        >
          {item.count}
        </span>
      )}
    </button>
  );
}
