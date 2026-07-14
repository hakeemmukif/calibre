"use client";
// Profile & targets page (spec 2026-07-12 §7): base country + relocation,
// save-on-change PUT /api/profile. Mirrors sources/page.tsx's busy/error/
// Retry pattern. A 404 here means an unseeded install — surfaced, not
// defaulted (fail loud).
import * as React from "react";
import { ProfileTargets } from "@/caliber-ui/compositions/Profile/ProfileTargets";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getProfile, updateProfile } from "@/features/profile/client";
import type { Profile, RelocationPref } from "@/types";

export default function ProfilePage() {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setError(undefined);
    try {
      setProfile(await getProfile());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the profile.");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleRelocationChange(relocation: RelocationPref) {
    if (!profile || relocation === profile.relocation) return;
    setBusy(true);
    setError(undefined);
    try {
      setProfile(
        await updateProfile({
          baseCountry: profile.baseCountry,
          relocation,
          scheduleFlex: profile.scheduleFlex,
          employmentPref: profile.employmentPref,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Profile & targets</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--danger-soft)",
              color: "var(--danger-ink)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="triangle-alert" size={16} />
              <span style={{ font: "var(--type-body)" }}>{error}</span>
            </div>
            <Button variant="secondary" iconLeft="refresh-cw" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
        {profile && <ProfileTargets profile={profile} busy={busy} onRelocationChange={handleRelocationChange} />}
      </div>
    </div>
  );
}
