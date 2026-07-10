"use client";
import * as React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
}

// Input — a labeled text field with a token-driven focus ring.
// NOTE: `style` is applied to the wrapping <label>; all other props pass to the <input>.
export function Input({
  label,
  defaultValue,
  value,
  placeholder,
  type = "text",
  onChange,
  style,
  ...rest
}: InputProps) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: "block", ...style }}>
      {label && (
        <span style={{ display: "block", font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
          {label}
        </span>
      )}
      <input
        type={type}
        defaultValue={defaultValue}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          font: "var(--type-body)",
          color: "var(--text-strong)",
          background: "var(--surface)",
          border: `1px solid ${focus ? "var(--accent)" : "var(--border-strong)"}`,
          borderRadius: "var(--radius-sm)",
          outline: "none",
          boxShadow: focus ? "var(--shadow-focus)" : "none",
          transition: "border-color var(--transition), box-shadow var(--transition)",
        }}
        {...rest}
      />
    </label>
  );
}
