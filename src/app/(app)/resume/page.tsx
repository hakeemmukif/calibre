"use client";
// F1 — résumé upload/view, wired to the real backend
// (component-inventory.md ResumeUpload/ResumeView; api-contract.md §3
// "POST/GET /api/resume"). Upload no longer auto-starts a scan: once a
// résumé is confirmed (ResumeUpload's `done` state), the user reviews it
// and explicitly picks a persona to start exactly one scan.
import * as React from "react";
import { useRouter } from "next/navigation";
import { ResumeUpload, type ResumeUploadStatus } from "@/caliber-ui/compositions/Resume/ResumeUpload";
import { ResumeView } from "@/caliber-ui/compositions/Resume/ResumeView";
import { FinishSetupCard, type FinishSetupValues } from "@/caliber-ui/compositions/Resume/FinishSetupCard";
import { Card } from "@/caliber-ui/components/Card";
import { Button } from "@/caliber-ui/components/Button";
import { Icon } from "@/caliber-ui/components/Icon";
import { getResume, uploadResume } from "@/features/resume/client";
import { startSearch } from "@/features/search/client";
import { getProfile, updateProfile } from "@/features/profile/client";
import { ApiError } from "@/features/http";
import { showDenial } from "@/features/credits/creditsStore";
import type { Resume, Profile } from "@/types";

export default function ResumePage() {
  const router = useRouter();
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<ResumeUploadStatus>("idle");
  const [error, setError] = React.useState<string | undefined>();
  const [searchError, setSearchError] = React.useState<string | undefined>();
  const [justUploaded, setJustUploaded] = React.useState(false);
  const [scanLaunching, setScanLaunching] = React.useState<"remote" | "local" | null>(null);
  const lastPersonaRef = React.useRef<"remote" | "local">("remote");
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [profileMissing, setProfileMissing] = React.useState(false);
  const [setupBusy, setSetupBusy] = React.useState(false);
  const [setupError, setSetupError] = React.useState<string | undefined>();

  async function handleScan(persona: "remote" | "local") {
    lastPersonaRef.current = persona;
    setScanLaunching(persona);
    setSearchError(undefined);
    try {
      const run = await startSearch({ persona });
      router.push(`/scans/${run.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_CREDITS") {
        const d = err.details as { feature: string; required: number; balance: number };
        showDenial(d);
      }
      setSearchError(err instanceof Error ? err.message : "Scan failed to start.");
      setScanLaunching(null);
    }
  }

  const loadProfile = React.useCallback(async () => {
    try {
      setProfile(await getProfile());
      setProfileMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setProfileMissing(true);
      else setSetupError(err instanceof Error ? err.message : "Couldn't load the profile.");
    }
  }, []);

  React.useEffect(() => {
    void getResume().then((r) => {
      setResume(r);
      setLoaded(true);
    });
    void loadProfile();
  }, [loadProfile]);

  async function handleFile(file: File) {
    setStatus("uploading");
    setError(undefined);
    try {
      // ResumeUpload's "paste text instead" path wraps the pasted text into a
      // text/plain File (its only upload path) — route it to the JSON
      // `{text}` body; anything else (PDF/DOCX) goes multipart.
      setStatus("parsing");
      const uploaded =
        file.type === "text/plain" ? await uploadResume({ text: await file.text() }) : await uploadResume({ file });
      setStatus("done");
      setResume(uploaded);
      setJustUploaded(true);
      void loadProfile();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't parse that file.");
    }
  }

  async function handleFinishSetup(values: FinishSetupValues) {
    if (!profile) return;
    setSetupBusy(true);
    setSetupError(undefined);
    try {
      setProfile(
        await updateProfile({
          baseCountry: profile.baseCountry,
          relocation: profile.relocation,
          scheduleFlex: profile.scheduleFlex,
          employmentPref: profile.employmentPref,
          displayLocation: values.displayLocation ?? profile.displayLocation,
          targetRole: values.targetRole ?? profile.targetRole,
          salaryMin: profile.salaryMin,
          salaryMax: profile.salaryMax,
          salaryCurrency: profile.salaryCurrency,
          salaryCadence: profile.salaryCadence,
        }),
      );
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSetupBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {resume ? (
          <>
            {searchError && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--danger-soft)",
                  color: "var(--danger-ink)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="triangle-alert" size={16} />
                  <span style={{ font: "var(--type-body)" }}>{searchError}</span>
                </div>
                <Button variant="secondary" iconLeft="refresh-cw" onClick={() => void handleScan(lastPersonaRef.current)}>
                  Retry
                </Button>
              </div>
            )}
            {justUploaded && (
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Résumé ready</div>
                    <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
                      Review it below, then scan for matching roles when you're ready. A scan costs 10 credits.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="primary" disabled={scanLaunching !== null} onClick={() => void handleScan("remote")}>
                      Scan remote roles
                    </Button>
                    <Button variant="secondary" disabled={scanLaunching !== null} onClick={() => void handleScan("local")}>
                      Scan local roles
                    </Button>
                    <Button variant="ghost" onClick={() => setJustUploaded(false)}>Not now</Button>
                  </div>
                </div>
              </Card>
            )}
            {profile && profile.targetRole === null && (
              <FinishSetupCard
                needsTargetRole
                needsLocation={profile.displayLocation === null}
                busy={setupBusy}
                error={setupError}
                onSubmit={(v) => void handleFinishSetup(v)}
              />
            )}
            {profileMissing && (
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
                    Complete your profile to enable scanning.
                  </div>
                  <Button variant="secondary" onClick={() => router.push("/profile")}>
                    Open Profile &amp; targets
                  </Button>
                </div>
              </Card>
            )}
            <ResumeView
              resume={resume}
              onReupload={() => {
                setResume(null);
                setStatus("idle");
                setSearchError(undefined);
              }}
            />
          </>
        ) : (
          <ResumeUpload status={status} onFile={handleFile} error={error} />
        )}
      </div>
    </div>
  );
}
