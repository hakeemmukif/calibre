"use client";
// Onboarding (step 4 task 3): the only authenticated-but-profile-less
// destination. A fresh registrant has no profile row yet, so this composes
// ProfileTargets over local (unsaved) state, then a single PUT /api/profile
// (upsert — see server/persistence/repos/profile.ts) creates the row and
// hands off to /feed. Mirrors profile/page.tsx's busy/error pattern.
import * as React from "react";
import { useRouter } from "next/navigation";
import { ProfileTargets, type ProfileDialsBundle } from "@/caliber-ui/compositions/Profile/ProfileTargets";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { Card } from "@/caliber-ui/components/Card";
import { updateProfile } from "@/features/profile/client";
import type { Profile, RelocationPref, ScheduleFlex, EmploymentPref } from "@/types";

// Initial (unsaved) form state — not a fetched profile. baseCountry has a
// single option today (Malaysia); the four dials default to the most
// permissive setting until the registrant picks otherwise. Nothing here is
// persisted until Save (a single PUT of all four fields).
const INITIAL_PROFILE: Profile = {
  baseCountry: "MY", relocation: "stay",
  scheduleFlex: "any-hours", employmentPref: "any",
  updatedAt: new Date(0).toISOString(),
};

export default function OnboardingPage() {
  const router = useRouter();
  const [profile, setProfile] = React.useState<Profile>(INITIAL_PROFILE);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  function handleRelocationChange(relocation: RelocationPref) {
    setProfile((p) => ({ ...p, relocation }));
  }

  function handleScheduleChange(scheduleFlex: ScheduleFlex) {
    setProfile((p) => ({ ...p, scheduleFlex }));
  }

  function handleEmploymentChange(employmentPref: EmploymentPref) {
    setProfile((p) => ({ ...p, employmentPref }));
  }

  function handlePresetSelect(bundle: ProfileDialsBundle) {
    setProfile((p) => ({ ...p, ...bundle }));
  }

  async function handleSave() {
    setBusy(true);
    setError(undefined);
    try {
      await updateProfile({
        baseCountry: profile.baseCountry, relocation: profile.relocation,
        scheduleFlex: profile.scheduleFlex, employmentPref: profile.employmentPref,
      });
      router.push("/feed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
      <Card padding="md" radius="lg" elevation="sm">
        <div style={{ font: "700 20px/1.2 var(--font-display)", color: "var(--text-strong)" }}>Welcome to Caliber</div>
        <div style={{ font: "var(--type-body)", color: "var(--text-muted)", marginTop: 4 }}>
          Set your job targets to get started.
        </div>
      </Card>
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            background: "var(--danger-soft)",
            color: "var(--danger-ink)",
          }}
        >
          <Icon name="triangle-alert" size={16} />
          <span style={{ font: "var(--type-body)" }}>{error}</span>
        </div>
      )}
      <ProfileTargets
        profile={profile}
        busy={busy}
        onRelocationChange={handleRelocationChange}
        onScheduleChange={handleScheduleChange}
        onEmploymentChange={handleEmploymentChange}
        onPresetSelect={handlePresetSelect}
      />
      <Button variant="primary" onClick={() => void handleSave()} disabled={busy}>
        {busy ? "Saving…" : "Get started"}
      </Button>
    </div>
  );
}
