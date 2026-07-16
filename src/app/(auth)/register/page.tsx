"use client";
// Register page (step-4 task-2): AuthCard(mode="register") -> register() ->
// success pushes to '/', which is session-aware and re-routes to
// onboarding/feed. The server's error message (e.g. duplicate email) is
// shown verbatim — no client-side auth logic.
// Invite code (membership spec §4.5.2) rides into AuthCard via the
// `extraFields` slot so it renders inside the card with email/password;
// AuthCard's onSubmit(email, password) signature stays untouched, so login
// (which passes no extraFields) is visually unchanged.
import * as React from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/caliber-ui/compositions/Auth/AuthCard";
import { Input } from "@/caliber-ui/components/Input";
import { register } from "@/features/auth/client";

export default function RegisterPage() {
  const router = useRouter();
  const [inviteCode, setInviteCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  async function handleSubmit(email: string, password: string) {
    setBusy(true);
    setError(undefined);
    try {
      await register({ email, password, inviteCode });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      mode="register"
      extraFields={
        <Input
          label="Invite code"
          required
          value={inviteCode}
          disabled={busy}
          onChange={(e) => setInviteCode(e.target.value)}
        />
      }
      onSubmit={handleSubmit}
      busy={busy}
      error={error}
      switchHref="/login"
      switchLabel="Sign in instead"
    />
  );
}
