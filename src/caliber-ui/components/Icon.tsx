"use client";
import * as React from "react";
import {
  Target, CircleCheck, BadgeCheck, Check, X, Users, FileText, Mail, TrendingUp,
  Radar, SlidersHorizontal, Sparkles, Send, Clock, Shield, Zap, Download, Upload,
  RefreshCw, ArrowRight, ArrowLeft, ChevronDown, ChevronUp, Calendar, BookOpen, BarChart3,
  TriangleAlert, Search, Ghost, Layers, Plus, CircleHelp, MessageSquare, Pencil,
  Copy, Link2, Circle, Activity, Building2, Slash, type LucideIcon, type LucideProps,
} from "lucide-react";

// Caliber's icon set: stable kebab-case names mapped to lucide-react components,
// so call sites stay readable (`<Icon name="check" />`). stroke=currentColor,
// width 2 by default. Unknown names fall back to a circle so layout never breaks.
const ICONS: Record<string, LucideIcon> = {
  "target": Target,
  "circle-check": CircleCheck,
  "badge-check": BadgeCheck,
  "check": Check,
  "x": X,
  "users": Users,
  "file-text": FileText,
  "mail": Mail,
  "trending-up": TrendingUp,
  "radar": Radar,
  "sliders-horizontal": SlidersHorizontal,
  "sparkles": Sparkles,
  "send": Send,
  "clock": Clock,
  "shield": Shield,
  "zap": Zap,
  "download": Download,
  "upload": Upload,
  "refresh-cw": RefreshCw,
  "arrow-right": ArrowRight,
  "arrow-left": ArrowLeft,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "slash": Slash,
  "calendar": Calendar,
  "book-open": BookOpen,
  "bar-chart-3": BarChart3,
  "triangle-alert": TriangleAlert,
  "search": Search,
  "ghost": Ghost,
  "layers": Layers,
  "plus": Plus,
  "circle-help": CircleHelp,
  "message-square": MessageSquare,
  "pencil": Pencil,
  "copy": Copy,
  // stub: lucide-react dropped brand icons; "linkedin" now maps to a generic link glyph.
  "linkedin": Link2,
  "activity": Activity,
  "building": Building2,
};

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<LucideProps, "ref" | "size" | "strokeWidth"> {
  /** Stable kebab-case icon name (see the ICONS map for the full set). */
  name: IconName | (string & {});
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, strokeWidth = 2, style, ...rest }: IconProps): React.ReactElement {
  const Cmp = ICONS[name] ?? Circle;
  if (!ICONS[name] && typeof console !== "undefined") {
    console.warn(`[Caliber] Unknown icon "${name}" — falling back to a circle.`);
  }
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
      {...rest}
    />
  );
}
