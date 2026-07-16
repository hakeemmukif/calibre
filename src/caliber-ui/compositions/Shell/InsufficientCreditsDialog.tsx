"use client";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { useCredits, dismissDenial } from "@/features/credits/creditsStore";

const FEATURE_LABEL: Record<string, string> = {
  scan: "Scans", evaluate: "Checks", tailor: "Tailoring", resume: "Résumé extraction", answers: "Answers",
};

// InsufficientCreditsDialog — the 402 INSUFFICIENT_CREDITS empty-wallet
// modal (spec §4.4). Renders only while a denial is set; dismisses via the
// creditsStore so any 402 catch site across the app can trigger it.
export function InsufficientCreditsDialog() {
  const { denial } = useCredits();
  if (!denial) return null;

  const label = FEATURE_LABEL[denial.feature] ?? denial.feature;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "color-mix(in srgb, var(--text-strong) 35%, transparent)",
      }}
    >
      <Card radius="xl" elevation="lg" padding="lg" style={{ maxWidth: 360 }}>
        <h3 style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8 }}>
          {label} cost{label.endsWith("s") ? "" : "s"} {denial.required} credits — you have {denial.balance}.
        </h3>
        <p style={{ font: "var(--type-body)", color: "var(--text-body)", marginBottom: 16 }}>
          Get 150 credits for $5 — message the operator to top up; credits never expire.
        </p>
        <Button variant="primary" fullWidth onClick={dismissDenial}>Got it</Button>
      </Card>
    </div>
  );
}
