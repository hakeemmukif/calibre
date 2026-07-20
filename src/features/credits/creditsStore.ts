"use client";
import { useSyncExternalStore } from "react";
import { getCredits } from "./client";
import { track } from "@/features/analytics/client";
import { EVENTS } from "@/features/analytics/events";

export interface CreditDenial { feature: string; required: number; balance: number }

// Module-singleton state. Both start null — no fallback zero; balance/plan
// stay null until the first successful refresh.
let balance: number | null = null;
let plan: "standard" | "unlimited" | null = null;
let denial: CreditDenial | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }

// ---- public API (bound into the hook) ----
export function refreshCredits(): void {
  void getCredits()
    .then((c) => {
      balance = c.balance;
      plan = c.plan;
      emit();
    })
    .catch(() => {
      // A failed refresh leaves prior state untouched — never resets to 0/null.
    });
}

export function showDenial(d: CreditDenial): void {
  denial = d;
  track(EVENTS.creditsDepleted, { feature: d.feature, required: d.required, balance: d.balance });
  emit();
}
export function dismissDenial(): void {
  denial = null;
  emit();
}

// Test-only reset.
export function __resetCreditsStore() {
  balance = null; plan = null; denial = null;
}

interface CreditsSnapshot {
  balance: number | null;
  plan: "standard" | "unlimited" | null;
  denial: CreditDenial | null;
}
let snapshotCache: CreditsSnapshot = { balance, plan, denial };
function getSnapshot() {
  // Return a NEW object when data changes so useSyncExternalStore re-renders;
  // keep the SAME reference when unchanged so it doesn't loop.
  if (snapshotCache.balance !== balance || snapshotCache.plan !== plan || snapshotCache.denial !== denial) {
    snapshotCache = { balance, plan, denial };
  }
  return snapshotCache;
}

export function useCredits() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { balance: snap.balance, plan: snap.plan, denial: snap.denial };
}
