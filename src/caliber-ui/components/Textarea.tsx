"use client";
import * as React from "react";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: React.ReactNode;
}

// Textarea — a labeled multi-line field with a token-driven focus ring,
// matched to Input/Select. The one shared textarea; nothing inline-styles
// its own <textarea> anymore.
export function Textarea({
  label,
  defaultValue,
  value,
  placeholder,
  onChange,
  style,
  rows = 4,
  ...rest
}: TextareaProps) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: "block", ...style }}>
      {label && (
        <span style={{ display: "block", font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 6 }}>
          {label}
        </span>
      )}
      <textarea
        rows={rows}
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
          resize: "vertical",
          transition: "border-color var(--transition), box-shadow var(--transition)",
        }}
        {...rest}
      />
    </label>
  );
}
