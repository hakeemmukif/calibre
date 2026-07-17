// Operator support channel (Decision 1, pre-launch consolidation): Telegram.
// Hardcoded constant because NEXT_PUBLIC_* env is not wired into the Docker
// build. The placeholder handle MUST be replaced with the operator's real
// handle before the first invite — operator runbook step 9 in the
// 2026-07-17 pre-launch-hardening plan.
export const OPERATOR_TELEGRAM_HANDLE = "caliber_operator_placeholder";

export function operatorTelegramUrl(): string {
  return `https://t.me/${OPERATOR_TELEGRAM_HANDLE}`;
}
