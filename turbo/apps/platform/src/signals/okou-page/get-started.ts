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
import { detach, Reason, resetSignal, waitForOperation } from "../utils.ts";
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

/**
 * Which quest's intro dialog is open, if any.
 *
 * The panel is a dropdown and its rows close it on select, so the dialog that
 * explains a quest cannot live in the panel's own tree. It is held here for the
 * same reason the share dialog is.
 */
const internalQuestIntroKey$ = state<GetStartedQuestKey | null>(null);
/**
 * Whether the workflow intro has advanced from its three steps to the prompt
 * it hands over. Every open starts on the steps.
 */
const internalQuestIntroPromptShown$ = state(false);
export const questIntroKey$ = computed((get) => {
  return get(internalQuestIntroKey$);
});
export const questIntroPromptShown$ = computed((get) => {
  return get(internalQuestIntroPromptShown$);
});
export const setQuestIntroKey$ = command(
  ({ set }, key: GetStartedQuestKey | null) => {
    set(internalQuestIntroKey$, key);
    set(internalQuestIntroPromptShown$, false);
  },
);
export const showQuestIntroPrompt$ = command(({ set }) => {
  set(internalQuestIntroPromptShown$, true);
});

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

/** Whether the check-in confirmation is showing; the check-in itself already ran. */
const internalCheckinClaimedOpen$ = state(false);
export const checkinClaimedOpen$ = computed((get) => {
  return get(internalCheckinClaimedOpen$);
});
export const setCheckinClaimedOpen$ = command(({ set }, open: boolean) => {
  set(internalCheckinClaimedOpen$, open);
});

export const checkInGetStarted$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(getStartedContract).checkin({
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(reloadGetStarted$);
    await Promise.all([
      waitForOperation(get(getStartedStatus$), signal),
      set(reloadAccountMenuCreditBalances$, signal),
    ]);
    signal.throwIfAborted();
  },
);

const refreshGetStartedFromRealtime$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    set(reloadGetStarted$);
    const data = await waitForOperation(get(getStartedStatus$), signal);
    signal.throwIfAborted();
    if (!data) {
      return true;
    }
    await set(reloadAccountMenuCreditBalances$, signal);
    signal.throwIfAborted();
    return false;
  },
);

/** An authenticated app daemon; reward availability never delays route readiness. */
export const setupGetStartedRewards$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    detach(
      (async (ownerSignal: AbortSignal): Promise<void> => {
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
      })(signal),
      Reason.Daemon,
      "get started",
    );
  },
);
