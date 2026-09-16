import { command, computed, state } from "ccstate";
import {
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedQuestKey,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "../api-client.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { accept } from "../../lib/accept.ts";
import {
  createDeferredPromise,
  resetSignal,
  setDaemon,
  settle,
  waitForOperation,
  withCleanup,
} from "../utils.ts";
import { reloadAccountMenuCreditBalances$ } from "./billing.ts";
import { setAblyLoop$ } from "../realtime.ts";

export type GetStartedQuestStatus = "todo" | "inReview" | "done" | "rejected";
export interface GetStartedQuest {
  readonly key: GetStartedQuestKey;
  readonly status: GetStartedQuestStatus;
  readonly earnedCredits: number;
  readonly claimedCount: number;
  readonly pendingCount: number;
  readonly limit: number | null;
  readonly canEarnMore: boolean;
  readonly rewardAmount: number;
  readonly rewardTarget: "user" | "org";
}

const reloadVersion$ = state(0);
const getStartedStatus$ = computed(
  async (get): Promise<GetStartedStatus | null> => {
    get(reloadVersion$);
    const switches = await get(featureSwitches$);
    if (!switches[FeatureSwitchKey.GetStartedQuests]) {
      return null;
    }
    await get(runtimeAuthenticatedIdentity$);
    const response = await accept(
      get(apiClient$)(getStartedContract).status(),
      [200, 403],
      undefined,
      { showErrorToast: false },
    );
    return response.status === 200 ? response.body : null;
  },
);
const reloadGetStarted$ = command(({ set }) => {
  set(reloadVersion$, (value) => {
    return value + 1;
  });
});
export const setGetStartedMenuOpen$ = command(({ set }, open: boolean) => {
  if (open) {
    set(reloadGetStarted$);
  }
});

export const getStartedQuests$ = computed(
  async (get): Promise<readonly GetStartedQuest[]> => {
    const data = await get(getStartedStatus$);
    if (!data) {
      return [];
    }
    return data.quests.map((quest) => {
      let status: GetStartedQuestStatus = (
        quest.key === "checkin" ? data.claimedToday : quest.claimedCount > 0
      )
        ? "done"
        : "todo";
      if (quest.key === "share" && status !== "done") {
        if (
          data.shareClaim?.status === "pending" ||
          data.shareClaim?.status === "reviewing"
        ) {
          status = "inReview";
        }
        if (
          data.shareClaim?.status === "rejected" ||
          data.shareClaim?.status === "ineligible"
        ) {
          status = "rejected";
        }
      }
      return { ...quest, status };
    });
  },
);
export interface GetStartedSummary {
  readonly completed: number;
  readonly total: number;
  readonly earnedCredits: number;
}
export const getStartedSummary$ = computed(
  async (get): Promise<GetStartedSummary> => {
    const quests = await get(getStartedQuests$);
    return {
      completed: quests.filter((quest) => {
        return quest.status === "done";
      }).length,
      total: quests.length,
      earnedCredits: quests
        .filter((quest) => {
          return quest.rewardTarget === "user";
        })
        .reduce((sum, quest) => {
          return sum + quest.earnedCredits;
        }, 0),
    };
  },
);

const internalShareDialogOpen$ = state(false);
const internalSharePostDraft$ = state("");
const internalShareSubmission$ = state<Promise<void> | null>(null);
const resetShareSubmission$ = resetSignal();
export const shareDialogOpen$ = computed((get) => {
  return get(internalShareDialogOpen$);
});
export const sharePostDraft$ = computed((get) => {
  return get(internalSharePostDraft$);
});
export const shareSubmission$ = computed((get) => {
  return get(internalShareSubmission$);
});
export const setShareDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalShareDialogOpen$, open);
  if (!open) {
    set(resetShareSubmission$);
    set(internalSharePostDraft$, "");
    set(internalShareSubmission$, null);
  }
});
export const setSharePostDraft$ = command(({ set }, draft: string) => {
  set(internalSharePostDraft$, draft);
});
const submitShareRequest$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(getStartedContract).submitShare({
        body: { url: get(internalSharePostDraft$).trim() },
        fetchOptions: { signal },
      }),
      [202],
      signal,
    );
    signal.throwIfAborted();
    set(reloadGetStarted$);
    set(internalShareDialogOpen$, false);
    set(internalSharePostDraft$, "");
  },
);
export const submitSharePost$ = command(
  async ({ set }, signal: AbortSignal) => {
    const requestSignal = set(resetShareSubmission$, signal);
    const pending = set(submitShareRequest$, requestSignal);
    set(internalShareSubmission$, pending);
    await pending;
    signal.throwIfAborted();
  },
);

/** Each wait owns its timer and focus listeners, all released on root cancellation. */
async function waitForRewardRefresh(
  milliseconds: number | null,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const next = createDeferredPromise<void>(signal);
  const wake = () => {
    if (!next.settled()) {
      next.resolve();
    }
  };
  const visible = () => {
    if (document.visibilityState === "visible") {
      wake();
    }
  };
  const timer =
    milliseconds === null ? null : window.setTimeout(wake, milliseconds);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", visible);
  await withCleanup(next.promise, () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", visible);
  });
}

const refreshAndCheckin$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadGetStarted$);
    let data = await waitForOperation(get(getStartedStatus$), signal);
    signal.throwIfAborted();
    if (!data) {
      return null;
    }
    if (!data.claimedToday) {
      const result = await accept(
        get(apiClient$)(getStartedContract).checkin({
          fetchOptions: { signal },
        }),
        [200, 403],
        signal,
        { showErrorToast: false },
      );
      signal.throwIfAborted();
      if (result.status === 403) {
        return null;
      }
      set(reloadGetStarted$);
      data = await waitForOperation(get(getStartedStatus$), signal);
      signal.throwIfAborted();
    }
    return data;
  },
);

const refreshGetStartedFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const data = await set(refreshAndCheckin$, signal);
    signal.throwIfAborted();
    if (!data) {
      return true;
    }
    await set(reloadAccountMenuCreditBalances$, signal);
    signal.throwIfAborted();
    return false;
  },
);

/** Focus and the next UTC boundary are explicit refresh triggers, not polling. */
const refreshGetStartedOnFocusAndUtcDay$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    let previousEarnings: number | null = null;
    while (!signal.aborted) {
      const result = await settle(set(refreshAndCheckin$, signal), signal);
      signal.throwIfAborted();
      let nextReset: number | null = null;
      if (result.ok) {
        const data = result.value;
        if (!data) {
          return;
        }
        const earnings = data.quests.reduce((sum, quest) => {
          return sum + quest.earnedCredits;
        }, 0);
        if (earnings !== previousEarnings) {
          await settle(set(reloadAccountMenuCreditBalances$, signal), signal);
          signal.throwIfAborted();
        }
        previousEarnings = earnings;
        nextReset = Math.max(
          250,
          Date.parse(data.nextResetAt) - Date.parse(data.serverNow),
        );
      }
      await waitForRewardRefresh(nextReset, signal);
      signal.throwIfAborted();
    }
  },
);

/** An authenticated app daemon; reward availability never delays route readiness. */
export const setupGetStartedRewards$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    setDaemon(async (ownerSignal) => {
      const switches = await get(featureSwitches$);
      ownerSignal.throwIfAborted();
      if (!switches[FeatureSwitchKey.GetStartedQuests]) {
        return;
      }
      set(
        setAblyLoop$,
        {
          topic: GET_STARTED_REWARDS_CHANGED_EVENT,
          loopCommand$: refreshGetStartedFromRealtime$,
          options: { runOnSubscribe: true },
        },
        ownerSignal,
      );
      await set(refreshGetStartedOnFocusAndUtcDay$, ownerSignal);
    }, signal);
  },
);
