"use client";
// Profile & targets page (spec 2026-07-12 §7, extended by
// 2026-07-14-remote-fit-criteria-design.md §8): base country + relocation/
// schedule/employment dials + a preset row, save-on-change PUT /api/profile.
// Mirrors sources/page.tsx's busy/error/Retry pattern. A 404 here means an
// unseeded install — surfaced, not defaulted (fail loud).
import * as React from "react";
import { ProfileTargets, type ProfileDialsBundle } from "@/caliber-ui/compositions/Profile/ProfileTargets";
import { JobTargets, type JobTargetsFields } from "@/caliber-ui/compositions/Profile/JobTargets";
import { ChangePasswordCard } from "@/caliber-ui/compositions/Profile/ChangePasswordCard";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getProfile, updateProfile } from "@/features/profile/client";
import { changePassword } from "@/features/auth/client";
import type { Profile, RelocationPref, ScheduleFlex, EmploymentPref } from "@/types";

export default function ProfilePage() {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [pwBusy, setPwBusy] = React.useState(false);
  const [pwError, setPwError] = React.useState<string | undefined>();
  const [pwSuccess, setPwSuccess] = React.useState(false);

  async function handleChangePassword(currentPassword: string, newPassword: string) {
    setPwBusy(true);
    setPwError(undefined);
    setPwSuccess(false);
    try {
      await changePassword({ currentPassword, newPassword });
      setPwSuccess(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setPwBusy(false);
    }
  }

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

  // Every PUT carries the full body — Profile requires all fields (Task 1),
  // and this is also what keeps a preset selection atomic: ONE PUT with all
  // three dials, never three racing per-dial PUTs off the same stale
  // `profile` snapshot.
  async function applyDials(next: ProfileDialsBundle) {
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    try {
      setProfile(
        await updateProfile({
          baseCountry: profile.baseCountry,
          displayLocation: profile.displayLocation,
          targetRole: profile.targetRole,
          salaryMin: profile.salaryMin,
          salaryMax: profile.salaryMax,
          salaryCurrency: profile.salaryCurrency,
          salaryCadence: profile.salaryCadence,
          ...next,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the profile.");
    } finally {
      setBusy(false);
    }
  }

  function handleRelocationChange(relocation: RelocationPref) {
    if (!profile || relocation === profile.relocation) return;
    void applyDials({ relocation, scheduleFlex: profile.scheduleFlex, employmentPref: profile.employmentPref });
  }

  function handleScheduleChange(scheduleFlex: ScheduleFlex) {
    if (!profile || scheduleFlex === profile.scheduleFlex) return;
    void applyDials({ relocation: profile.relocation, scheduleFlex, employmentPref: profile.employmentPref });
  }

  function handleEmploymentChange(employmentPref: EmploymentPref) {
    if (!profile || employmentPref === profile.employmentPref) return;
    void applyDials({ relocation: profile.relocation, scheduleFlex: profile.scheduleFlex, employmentPref });
  }

  function handlePresetSelect(bundle: ProfileDialsBundle) {
    if (
      !profile ||
      (bundle.relocation === profile.relocation &&
        bundle.scheduleFlex === profile.scheduleFlex &&
        bundle.employmentPref === profile.employmentPref)
    )
      return;
    void applyDials(bundle);
  }

  async function applyTargets(fields: JobTargetsFields) {
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    try {
      setProfile(
        await updateProfile({
          baseCountry: profile.baseCountry,
          relocation: profile.relocation,
          scheduleFlex: profile.scheduleFlex,
          employmentPref: profile.employmentPref,
          ...fields,
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
        {profile && (
          <>
            <ProfileTargets
              profile={profile}
              busy={busy}
              onRelocationChange={handleRelocationChange}
              onScheduleChange={handleScheduleChange}
              onEmploymentChange={handleEmploymentChange}
              onPresetSelect={handlePresetSelect}
            />
            <JobTargets profile={profile} busy={busy} onSave={(f) => void applyTargets(f)} />
          </>
        )}
        <ChangePasswordCard
          onSubmit={(current, next) => void handleChangePassword(current, next)}
          busy={pwBusy}
          error={pwError}
          success={pwSuccess}
        />
      </div>
    </div>
  );
}
