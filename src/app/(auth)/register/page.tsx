"use client";
// Register page (step-4 task-2): AuthCard(mode="register") -> register() ->
// success pushes to '/', which is session-aware and re-routes to
// onboarding/feed. The server's error message (e.g. duplicate email) is
// shown verbatim — no client-side auth logic.
import * as React from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/caliber-ui/compositions/Auth/AuthCard";
import { register } from "@/features/auth/client";

export default function RegisterPage() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  async function handleSubmit(email: string, password: string) {
    setBusy(true);
    setError(undefined);
    try {
      await register({ email, password });
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
      onSubmit={handleSubmit}
      busy={busy}
      error={error}
      switchHref="/login"
      switchLabel="Sign in instead"
    />
  );
}
