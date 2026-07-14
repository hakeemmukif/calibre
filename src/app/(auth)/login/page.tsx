"use client";
// Login page (step-4 task-2): AuthCard(mode="login") -> login() -> success
// pushes to '/', which is session-aware and re-routes to onboarding/feed.
// The server's error message (e.g. "Invalid email or password.") is shown
// verbatim — no client-side auth logic.
import * as React from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/caliber-ui/compositions/Auth/AuthCard";
import { login } from "@/features/auth/client";

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  async function handleSubmit(email: string, password: string) {
    setBusy(true);
    setError(undefined);
    try {
      await login({ email, password });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      mode="login"
      onSubmit={handleSubmit}
      busy={busy}
      error={error}
      switchHref="/register"
      switchLabel="Create an account"
    />
  );
}
