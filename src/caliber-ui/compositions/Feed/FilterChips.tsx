"use client";
import * as React from "react";
import { Chip } from "../../components/Chip";

// FeedFilter — the real (non-decorative) hero filter set, §11.8 (chip updated
// 2026-07-12): "All · New · Verified · Suspicious · Work anywhere · Fit ≥ 4".
// "anywhere" is eligibility-based (Job.eligibility.tier), replacing the old
// persona-based "remote" chip — tautological inside the remote lens.
export type FeedFilter = "all" | "new" | "verified" | "suspicious" | "anywhere" | "fit4";

export const FEED_FILTERS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "verified", label: "Verified" },
  { value: "suspicious", label: "Suspicious" },
  { value: "anywhere", label: "Work anywhere" },
  { value: "fit4", label: "Fit ≥ 4" },
];

export interface FilterChipsProps {
  active: FeedFilter;
  counts: Record<FeedFilter, number>;
  onChange(f: FeedFilter): void;
}

// FilterChips — real feed filters (§11.8): each one actually filters the feed.
export function FilterChips({ active, counts, onChange }: FilterChipsProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {FEED_FILTERS.map((f) => {
        const count = counts[f.value] ?? 0;
        const disabled = count === 0 && f.value !== "all";
        return (
          <Chip
            key={f.value}
            variant="filter"
            selected={active === f.value}
            disabled={disabled}
            onClick={() => onChange(f.value)}
          >
            {f.label} · {count}
          </Chip>
        );
      })}
    </div>
  );
}
