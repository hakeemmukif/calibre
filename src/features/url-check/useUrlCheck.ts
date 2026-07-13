"use client";
// F2 client hook — drives the pasted-URL check pipeline (api-contract.md §5
// "POST /api/jobs/check", "GET /api/jobs/check/:id"): kicks off `startCheck`,
// polls `getCheck` every 1.5s while the run is in flight, and on completion
// fetches the job via the existing feed client. features/* only — never
// imports @/server/* or lib/llm.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, UrlCheck } from "@/types";
import { getJob } from "@/features/feed/client";
import { startCheck, getCheck } from "./client";

export type UrlCheckStatus = "idle" | "running" | "needsText" | "done" | "failed";

export interface UrlCheckState {
  status: UrlCheckStatus;
  stage: string | null;
  check: UrlCheck | null;
  job: Job | null;
}

export interface UseUrlCheck {
  state: UrlCheckState;
  submit(url: string, text?: string): Promise<void>;
  dismiss(): void;
}

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 8; // consecutive failed polls before giving up (~24s of continuous outage)
const MAX_RUN_MS = 5 * 60_000; // overall per-run deadline (server orphan guard)

function idleState(): UrlCheckState {
  return { status: "idle", stage: null, check: null, job: null };
}

export function useUrlCheck(): UseUrlCheck {
  const [state, setState] = useState<UrlCheckState>(idleState());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every submit()/dismiss() so a poll or job-fetch that resolves
  // after the run moved on (a newer submit, or a dismiss) is a silent
  // no-op instead of clobbering fresher state.
  const generationRef = useRef(0);
  // `settle` recurses (it re-arms its own timeout) — held in a ref instead
  // of a self-referential useCallback so the recursive call always reads
  // the live closure without an exhaustive-deps false positive.
  const settleRef = useRef<((check: UrlCheck, generation: number) => Promise<void>) | undefined>(undefined);
  // Consecutive failed polls (any status) for the current generation — reset
  // on submit and on every successful poll. retryOrFail held in a ref for
  // the same reason as settleRef: it's invoked from settleRef's own closure.
  const pollFailuresRef = useRef(0);
  const deadlineRef = useRef(0);
  const retryOrFailRef = useRef<((check: UrlCheck, generation: number) => void) | undefined>(undefined);

  settleRef.current = async (check, generation) => {
    if (generation !== generationRef.current) return;
    // Every async resume below (getJob, and the poll's getCheck routed in
    // via .catch) must never hang the UI in "running" on a throw — caught
    // here and, generation-guarded, turned into a "failed" transition
    // (final review fix wave FIX 1b).
    try {
      if (check.status === "completed") {
        const job = check.jobId ? await getJob(check.jobId) : null;
        if (generation !== generationRef.current) return;
        setState({ status: "done", stage: check.stage, check, job });
        return;
      }
      if (check.status === "failed") {
        setState({ status: check.needsText ? "needsText" : "failed", stage: check.stage, check, job: null });
        return;
      }
      if (Date.now() > deadlineRef.current) {
        setState({ status: "failed", stage: check.stage, check, job: null });
        return;
      }
      setState({ status: "running", stage: check.stage, check, job: null });
      timerRef.current = setTimeout(() => {
        void getCheck(check.id)
          .then((next) => {
            pollFailuresRef.current = 0;
            return settleRef.current!(next, generation);
          })
          .catch(() => retryOrFailRef.current!(check, generation));
      }, POLL_MS);
    } catch {
      if (generation !== generationRef.current) return;
      retryOrFailRef.current!(check, generation);
    }
  };

  // A transient poll/job-fetch rejection (dev-recompile 500, network blip)
  // retries in place instead of failing the whole run — only a run of
  // MAX_POLL_FAILURES consecutive rejections, or the overall MAX_RUN_MS
  // deadline above, gives up.
  retryOrFailRef.current = (check, generation) => {
    if (generation !== generationRef.current) return;
    pollFailuresRef.current += 1;
    if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
      setState({ status: "failed", stage: check.stage, check, job: null });
      return;
    }
    timerRef.current = setTimeout(() => {
      void settleRef.current!(check, generation);
    }, POLL_MS);
  };

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const submit = useCallback(
    async (url: string, text?: string) => {
      clearTimer();
      const generation = ++generationRef.current;
      pollFailuresRef.current = 0;
      deadlineRef.current = Date.now() + MAX_RUN_MS;
      setState({ status: "running", stage: null, check: null, job: null });
      let check: UrlCheck;
      try {
        check = await startCheck({ url, text });
      } catch {
        if (generation !== generationRef.current) return;
        setState({ status: "failed", stage: null, check: null, job: null });
        return;
      }
      await settleRef.current!(check, generation);
    },
    [clearTimer],
  );

  const dismiss = useCallback(() => {
    clearTimer();
    generationRef.current += 1;
    setState(idleState());
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { state, submit, dismiss };
}
