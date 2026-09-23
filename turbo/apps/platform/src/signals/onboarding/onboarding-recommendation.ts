import { command } from "ccstate";
import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import { delay } from "signal-timers";

import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
  type SourcesFirstDraft,
} from "./onboarding-sources-first-state.ts";
import { resetSignal, setLoop, settle } from "../utils.ts";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 180;
const READY_FALLBACK_DELAY_MS = 12_000;
const resetRecommendationAttempt$ = resetSignal();

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

const pollOnboardingRecommendation$ = command(
  ({ get, set }, jobId: string, signal: AbortSignal): void => {
    const client = get(apiClient$)(onboardingRecommendationContract);
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

export const startOnboardingRecommendation$ = command(
  async (
    { get, set },
    args: {
      readonly industry: OnboardingIndustry;
      readonly locale: UserLocale;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const attemptSignal = set(resetRecommendationAttempt$, signal);
    const startedAt = now();
    set(updateSourcesFirstDraft$, {
      startingPromptDraft: "",
      startingPromptKey: "",
      recommendationJobId: null,
      recommendationStartedAt: startedAt,
      recommendationStatus: "starting",
      recommendation: null,
    });
    const client = get(apiClient$)(onboardingRecommendationContract);
    const started = await settle(
      accept(
        client.start({
          body: args,
          fetchOptions: { signal: attemptSignal },
        }),
        [202],
        attemptSignal,
        { showErrorToast: false },
      ),
      attemptSignal,
    );
    signal.throwIfAborted();
    attemptSignal.throwIfAborted();
    const current = get(sourcesFirstDraft$);
    // Changing direction retires this request even when its server-side job was
    // already too far along for browser cancellation to prevent creation.
    if (current.recommendationStartedAt !== startedAt) {
      return;
    }
    if (!started.ok) {
      set(updateSourcesFirstDraft$, { recommendationStatus: "failed" });
      return;
    }
    const { jobId } = started.value.body;
    set(updateSourcesFirstDraft$, {
      recommendationJobId: jobId,
      // A slow start response must not put Ready back behind a loader after the
      // bounded static fallback has already become editable.
      recommendationStatus:
        current.recommendationStatus === "timed-out" ? "timed-out" : "pending",
    });

    set(pollOnboardingRecommendation$, jobId, attemptSignal);
  },
);

/** Resume the owner-scoped durable job after a browser refresh or page change. */
export const resumeOnboardingRecommendation$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    const draft = get(sourcesFirstDraft$);
    if (
      draft.recommendationJobId === null ||
      draft.recommendationStatus === "completed" ||
      draft.recommendationStatus === "failed"
    ) {
      return;
    }
    const attemptSignal = set(resetRecommendationAttempt$, signal);
    set(
      pollOnboardingRecommendation$,
      draft.recommendationJobId,
      attemptSignal,
    );
  },
);

/** The ready step spends only the generation attempt's remaining wait budget. */
export const allowOnboardingRecommendationFallback$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const draft = get(sourcesFirstDraft$);
    const { recommendationStartedAt: startedAt, recommendationStatus: status } =
      draft;
    if (status !== "starting" && status !== "pending" && status !== "running") {
      return;
    }
    if (startedAt === null) {
      throw new Error("Active onboarding recommendation has no start time");
    }
    const remaining = Math.min(
      READY_FALLBACK_DELAY_MS,
      Math.max(0, startedAt + READY_FALLBACK_DELAY_MS - now()),
    );
    if (remaining > 0) {
      await delay(remaining, { signal });
      signal.throwIfAborted();
    }
    const current = get(sourcesFirstDraft$);
    if (
      current.recommendationStartedAt === startedAt &&
      (current.recommendationStatus === "starting" ||
        current.recommendationStatus === "pending" ||
        current.recommendationStatus === "running")
    ) {
      set(updateSourcesFirstDraft$, { recommendationStatus: "timed-out" });
    }
  },
);
