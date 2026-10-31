import { command, computed, state } from "ccstate";
import { onboardingRecommendationContract } from "@okouai/api-contracts/client/onboarding";
import type { OnboardingRecommendationStatus } from "@okouai/api-contracts/contracts/onboarding";
import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
} from "./onboarding-sources-first-state.ts";
import { resetSignal } from "../utils.ts";

const resetRecommendationAttempt$ = resetSignal();
const recommendationRevision$ = state(0);
// Draft edits must not re-read the job; only a new job ID or a notification.
const recommendationJobId$ = computed((get) => {
  return get(sourcesFirstDraft$).recommendationJobId;
});

/** The current job, or null when none was started or it no longer exists. */
export const onboardingRecommendation$ = computed(
  async (get): Promise<OnboardingRecommendationStatus | null> => {
    get(recommendationRevision$);
    const jobId = get(recommendationJobId$);
    if (jobId === null) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(onboardingRecommendationContract).get({
        params: { jobId },
      }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  },
);

const invalidateOnboardingRecommendation$ = command(({ set }) => {
  set(recommendationRevision$, (revision) => {
    return revision + 1;
  });
  return false;
});

/** The API notifies the user when a recommendation job settles. */
export const watchOnboardingRecommendation$ = command(
  ({ set }, signal: AbortSignal): Promise<void> => {
    set(
      setAblyLoop$,
      {
        topic: "onboardingRecommendationChanged",
        loopCommand$: invalidateOnboardingRecommendation$,
        // A job that settled before the subscription attached is re-read.
        options: { runOnSubscribe: true },
      },
      signal,
    );
    return Promise.resolve();
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
    });
    const started = await accept(
      get(apiClient$)(onboardingRecommendationContract).start({
        body: args,
        fetchOptions: { signal: attemptSignal },
      }),
      [202],
      attemptSignal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    attemptSignal.throwIfAborted();
    // Changing direction retires this request even when its server-side job was
    // already too far along for browser cancellation to prevent creation.
    if (get(sourcesFirstDraft$).recommendationStartedAt !== startedAt) {
      return;
    }
    set(updateSourcesFirstDraft$, { recommendationJobId: started.body.jobId });
  },
);
