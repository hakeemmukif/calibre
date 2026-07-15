"use client";
import * as React from "react";
import { Tag, type TagTone } from "../../components/Tag";
import { Icon } from "../../components/Icon";
import type { SourceEventData } from "../../../types";

export interface SourceStripProps {
  sources: SourceEventData[];
}

const TONE: Record<SourceEventData["status"], TagTone> = {
  done: "good",
  fetching: "neutral",
  error: "danger",
};

// SourceStrip — a flex row of per-source discovery chips shown during a live
// scan. Pure presentational: tone follows status, the `fetching` chip spins
// via the shared `caliber-spin` keyframe. No fetching.
export function SourceStrip({ sources }: SourceStripProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {sources.map((source) => (
        <Tag key={source.sourceId} tone={TONE[source.status]}>
          {source.status === "fetching" && (
            <Icon name="refresh-cw" size={12} style={{ animation: "caliber-spin 1s linear infinite" }} />
          )}
          {source.name}
          {source.found != null && ` · ${source.found}`}
        </Tag>
      ))}
    </div>
  );
}
