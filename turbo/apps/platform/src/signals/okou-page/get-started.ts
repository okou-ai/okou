import { command, computed, state } from "ccstate";
import type { AgentPhoneLinkStatusResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import type { SlackOrgStatus } from "@okouai/api-contracts/contracts/integrations-slack";
import {
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedQuestKey,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { accept } from "../../lib/accept.ts";
import { resetSignal, settle, waitForOperation } from "../utils.ts";
import { reloadAccountMenuCreditBalances$ } from "./billing.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { agentPhoneLinkStatus$ } from "./agentphone.ts";
import { slackOrgData$ } from "./slack.ts";

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
  /** Why the last claim was turned down, when one was. */
  readonly rejectedReason: string | null;
}

/**
 * The quests whose reward is decided by the review worker rather than by the
 * act itself.
 *
 * `processGetStartedClaims` leases exactly these two keys, so a claim of theirs
 * sitting in `pending` means a reviewer still holds it. Everything else is
 * granted inside the transaction that completes it and never waits.
 */
const REVIEWED_QUEST_KEYS: ReadonlySet<GetStartedQuestKey> = new Set([
  "share",
  "workflow",
]);

const reloadVersion$ = state(0);
const getStartedStatus$ = computed(
  async (get): Promise<GetStartedStatus | null> => {
    get(reloadVersion$);
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

/**
 * The latest share claim, which carries what the row cannot: which post is in
 * the queue and when it went in.
 */
export const shareClaim$ = computed(async (get) => {
  const data = await get(getStartedStatus$);
  return data?.shareClaim ?? null;
});

/**
 * The iMessage quest, reconciled with the phone link itself.
 *
 * The reward is only granted when a link is created, so a member whose phone
 * was linked before the quest existed holds no claim for it -- but they have
 * done the step, and a row asking them to do it again would be wrong. Their
 * row reads as finished instead, without the credits. A workspace with no
 * AgentPhone number has nothing to text, so the row is not offered at all.
 */
function reconcileImessageQuest(
  quests: readonly GetStartedQuest[],
  imessage: GetStartedQuest,
  link: AgentPhoneLinkStatusResponse,
): readonly GetStartedQuest[] {
  if (link.linked) {
    return quests.map((quest): GetStartedQuest => {
      return quest === imessage
        ? { ...quest, status: "done", canEarnMore: false }
        : quest;
    });
  }
  if (link.agentPhoneNumber === null) {
    return quests.filter((quest) => {
      return quest !== imessage;
    });
  }
  return quests;
}

/**
 * The Slack quest, reconciled with the org's Slack install.
 *
 * Like the iMessage quest, the reward is only granted by the install flow, so
 * a workspace that added Slack before the quest existed holds no claim for it.
 * The step is done all the same, and offering to install an app that is
 * already installed leads nowhere. The row reads as finished, without the
 * credits.
 */
function reconcileSlackQuest(
  quests: readonly GetStartedQuest[],
  slack: GetStartedQuest,
  org: SlackOrgStatus,
): readonly GetStartedQuest[] {
  if (org.isInstalled !== true) {
    return quests;
  }
  return quests.map((quest): GetStartedQuest => {
    return quest === slack
      ? { ...quest, status: "done", canEarnMore: false }
      : quest;
  });
}

export const getStartedQuests$ = computed(
  async (get): Promise<readonly GetStartedQuest[]> => {
    const data = await get(getStartedStatus$);
    if (!data) {
      return [];
    }
    const quests = data.quests.map((quest): GetStartedQuest => {
      let status: GetStartedQuestStatus = (
        quest.key === "checkin" ? data.claimedToday : quest.claimedCount > 0
      )
        ? "done"
        : "todo";
      let rejectedReason: string | null = null;
      // A reviewed quest that has a claim in flight is waiting, not untouched.
      // Without this the workflow row kept offering its own action for as long
      // as the hourly worker took to reach the claim the user had just earned.
      if (
        status === "todo" &&
        REVIEWED_QUEST_KEYS.has(quest.key) &&
        quest.pendingCount > 0
      ) {
        status = "inReview";
      }
      if (quest.key === "share" && status === "todo") {
        // The claim carries the outcome of the latest attempt, including the
        // reason it was turned down, which the per-quest counts cannot express.
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
          rejectedReason = data.shareClaim.reason;
        }
      }
      return { ...quest, status, rejectedReason };
    });
    const slack = quests.find((quest) => {
      return quest.key === "slack";
    });
    // Only a quest that can still be earned depends on the install. A failed
    // Slack read leaves the quest as the API reported it instead of taking the
    // whole list down; the Slack surfaces own reporting that failure.
    const slackOrg = slack?.canEarnMore
      ? await settle(get(slackOrgData$))
      : null;
    const withSlack =
      slack && slackOrg?.ok
        ? reconcileSlackQuest(quests, slack, slackOrg.value)
        : quests;
    const imessage = withSlack.find((quest) => {
      return quest.key === "imessage";
    });
    // Only a quest that can still be earned depends on the link.
    if (!imessage?.canEarnMore) {
      return withSlack;
    }
    return reconcileImessageQuest(
      withSlack,
      imessage,
      await get(agentPhoneLinkStatus$),
    );
  },
);

/**
 * What linking a phone still pays, or null once it pays nothing -- already
 * earned, already linked, or not offered in this workspace.
 */
export const imessageQuestReward$ = computed(
  async (get): Promise<number | null> => {
    const quest = (await get(getStartedQuests$)).find((candidate) => {
      return candidate.key === "imessage";
    });
    return quest?.canEarnMore ? quest.rewardAmount : null;
  },
);
export interface GetStartedSummary {
  readonly completed: number;
  readonly total: number;
  /** Credits still claimable, which is what the panel leads with. */
  readonly remainingCredits: number;
  readonly checkinStreak: number;
}
export const getStartedSummary$ = computed(
  async (get): Promise<GetStartedSummary> => {
    const quests = await get(getStartedQuests$);
    const status = await get(getStartedStatus$);
    return {
      completed: quests.filter((quest) => {
        return quest.status === "done";
      }).length,
      total: quests.length,
      remainingCredits: quests
        .filter((quest) => {
          return quest.canEarnMore && quest.status !== "inReview";
        })
        .reduce((sum, quest) => {
          return sum + quest.rewardAmount;
        }, 0),
      checkinStreak: status?.checkinStreak ?? 0,
    };
  },
);

/** Whether the panel's reward note is unfolded. */
const rewardsNoteOpenState$ = state(false);
export const rewardsNoteOpen$ = computed((get) => {
  return get(rewardsNoteOpenState$);
});
export const setRewardsNoteOpen$ = command(({ set }, open: boolean) => {
  set(rewardsNoteOpenState$, open);
});

/**
 * Which quest's intro dialog is open, if any.
 *
 * The panel is a dropdown and its rows close it on select, so the dialog that
 * explains a quest cannot live in the panel's own tree. It is held here for the
 * same reason the share dialog is.
 */
const internalQuestIntroKey$ = state<GetStartedQuestKey | null>(null);
export const questIntroKey$ = computed((get) => {
  return get(internalQuestIntroKey$);
});
/**
 * The quest whose intro was last open. It outlives the close so the dialog's
 * body stays mounted through its exit transition instead of going blank.
 */
const internalQuestIntroLastKey$ = state<GetStartedQuestKey | null>(null);
export const questIntroLastKey$ = computed((get) => {
  return get(internalQuestIntroLastKey$);
});
export const setQuestIntroKey$ = command(
  ({ set }, key: GetStartedQuestKey | null) => {
    set(internalQuestIntroKey$, key);
    if (key !== null) {
      set(internalQuestIntroLastKey$, key);
    }
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

/** Whether the success dialog is showing after a completed check-in. */
const internalCheckinClaimedOpen$ = state(false);
export const checkinClaimedOpen$ = computed((get) => {
  return get(internalCheckinClaimedOpen$);
});
export const setCheckinClaimedOpen$ = command(({ set }, open: boolean) => {
  set(internalCheckinClaimedOpen$, open);
});

export const checkInGetStarted$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
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
  ({ set }, signal: AbortSignal): void => {
    set(
      setAblyLoop$,
      {
        topic: GET_STARTED_REWARDS_CHANGED_EVENT,
        loopCommand$: refreshGetStartedFromRealtime$,
      },
      signal,
    );
  },
);
