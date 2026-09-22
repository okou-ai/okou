import { command } from "ccstate";
import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import { delay } from "signal-timers";

import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { apiClient$ } from "../api-client.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
  type SourcesFirstDraft,
} from "./onboarding-sources-first-state.ts";
import { setLoop, settle } from "../utils.ts";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 180;
const READY_FALLBACK_DELAY_MS = 12_000;

function retryablePollError(error: unknown): boolean {
  return (
    !(error instanceof ApiError) || error.status === 429 || error.status >= 500
  );
}

const updateCurrentJob$ = command(
  (
    { get, set },
    args: {
      readonly jobId: string;
      readonly patch: Partial<SourcesFirstDraft>;
      readonly preserveTimedOutFallback?: boolean;
    },
  ): void => {
    const draft = get(sourcesFirstDraft$);
    if (draft.recommendationJobId !== args.jobId) {
      return;
    }
    if (
      args.preserveTimedOutFallback === true &&
      draft.recommendationStatus === "timed-out"
    ) {
      return;
    }
    set(updateSourcesFirstDraft$, args.patch);
  },
);

export const startOnboardingRecommendation$ = command(
  async (
    { get, set },
    args: { readonly industry: OnboardingIndustry; readonly locale: string },
    signal: AbortSignal,
  ): Promise<void> => {
    set(updateSourcesFirstDraft$, {
      startingPromptDraft: "",
      startingPromptKey: "",
      recommendationJobId: null,
      recommendationStatus: "starting",
      recommendation: null,
    });
    const client = get(apiClient$)(onboardingRecommendationContract);
    const started = await settle(
      accept(
        client.start({
          body: args,
          fetchOptions: { signal },
        }),
        [202],
        signal,
        { showErrorToast: false },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!started.ok) {
      set(updateSourcesFirstDraft$, { recommendationStatus: "failed" });
      return;
    }
    const { jobId } = started.value.body;
    set(updateSourcesFirstDraft$, {
      recommendationJobId: jobId,
      recommendationStatus: "pending",
    });

    let pollAttempts = 0;
    setLoop(
      async (loopSignal) => {
        pollAttempts += 1;
        const polled = await settle(
          accept(
            client.get({
              params: { jobId },
              fetchOptions: { signal: loopSignal },
            }),
            [200, 404],
            loopSignal,
            { showErrorToast: false },
          ),
          loopSignal,
        );
        loopSignal.throwIfAborted();
        if (!polled.ok) {
          if (
            retryablePollError(polled.error) &&
            pollAttempts < MAX_POLL_ATTEMPTS
          ) {
            return false;
          }
          set(updateCurrentJob$, {
            jobId,
            patch: { recommendationStatus: "failed" },
          });
          return true;
        }
        if (polled.value.status === 404) {
          set(updateCurrentJob$, {
            jobId,
            patch: { recommendationStatus: "failed" },
          });
          return true;
        }
        const status = polled.value.body;
        if (status.status === "completed") {
          set(updateCurrentJob$, {
            jobId,
            patch: {
              recommendationStatus: "completed",
              recommendation: status.recommendation,
            },
          });
          return true;
        }
        if (status.status === "failed" || pollAttempts >= MAX_POLL_ATTEMPTS) {
          set(updateCurrentJob$, {
            jobId,
            patch: { recommendationStatus: "failed" },
          });
          return true;
        }
        set(updateCurrentJob$, {
          jobId,
          patch: { recommendationStatus: status.status },
          preserveTimedOutFallback: true,
        });
        return false;
      },
      POLL_INTERVAL_MS,
      signal,
      { retryTransientErrors: false },
    );
  },
);

/** The ready step waits visibly, then unlocks the deterministic local fallback. */
export const allowOnboardingRecommendationFallback$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const status = get(sourcesFirstDraft$).recommendationStatus;
    if (status !== "starting" && status !== "pending" && status !== "running") {
      return;
    }
    await delay(READY_FALLBACK_DELAY_MS, { signal });
    signal.throwIfAborted();
    const current = get(sourcesFirstDraft$).recommendationStatus;
    if (
      current === "starting" ||
      current === "pending" ||
      current === "running"
    ) {
      set(updateSourcesFirstDraft$, { recommendationStatus: "timed-out" });
    }
  },
);
