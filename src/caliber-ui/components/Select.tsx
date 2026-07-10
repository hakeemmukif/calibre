"use client";
import * as React from "react";
import { Icon } from "./Icon";

export type SelectOption = string | { value: string; label: string };

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "style"> {
  label?: React.ReactNode;
  options?: SelectOption[];
  /** Applied to the wrapping <label>. */
  style?: React.CSSProperties;
}

// Select — a labeled native select with a custom chevron, matched to Input.
export function Select({
  label,
  options = [],
  value,
  defaultValue,
  onChange,
  style,
  ...rest
}: SelectProps) {
  const [focus, setFocus] = React.useState(false);
  const opts = options.map((o) => (typeof o === "object" ? o : { value: o, label: o }));
  return (
    <label style={{ display: "block", ...style }}>
      {label && (
        <span style={{ display: "block", font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
          {label}
        </span>
      )}
      <div style={{ position: "relative" }}>
        <select
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            appearance: "none",
            WebkitAppearance: "none",
            padding: "10px 36px 10px 12px",
            font: "var(--type-body)",
            color: "var(--text-strong)",
            background: "var(--surface)",
            border: `1px solid ${focus ? "var(--accent)" : "var(--border-strong)"}`,
            borderRadius: "var(--radius-sm)",
            outline: "none",
            boxShadow: focus ? "var(--shadow-focus)" : "none",
            cursor: "pointer",
            transition: "border-color var(--transition), box-shadow var(--transition)",
          }}
          {...rest}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: "var(--text-muted)",
            display: "grid",
          }}
        >
          <Icon name="chevron-down" size={16} />
        </span>
      </div>
    </label>
  );
}
