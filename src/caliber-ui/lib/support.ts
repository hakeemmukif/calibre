// Operator support channel (Decision 1, pre-launch consolidation): Telegram.
// Hardcoded constant because NEXT_PUBLIC_* env is not wired into the Docker
// build. Stored WITHOUT the leading "@" — operatorTelegramUrl() interpolates
// it into a t.me/ path, where the bare username is required (operator handle
// @distro_ball; runbook step 9, 2026-07-17 pre-launch-hardening plan).
export const OPERATOR_TELEGRAM_HANDLE = "distro_ball";

export function operatorTelegramUrl(): string {
  return `https://t.me/${OPERATOR_TELEGRAM_HANDLE}`;
}
