import { command, computed, state } from "ccstate";
import type { AgentPhoneLinkStatusResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import type { SlackOrgStatus } from "@okouai/api-contracts/contracts/integrations-slack";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/validators/get-started";
import { getStartedContract } from "@okouai/api-contracts/client/get-started";
import type {
  GetStartedQuestKey,
  GetStartedStatus,
  GetStartedClaim,
} from "@okouai/api-contracts/contracts/get-started";
import { apiClient$ } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { subscribeBuiltinConnectorChanges$ } from "../external/connectors.ts";
import { pageSignal$, pageVersion$ } from "../page-signal.ts";
import { accept } from "../../lib/accept.ts";
import { onRef, resetSignal, settle } from "../utils.ts";
import { reloadAccountMenuCreditBalances$ } from "./billing.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { agentPhoneLinkStatus$ } from "./agentphone.ts";
import { reloadSlackOrg$, slackOrgData$ } from "./slack.ts";

export type GetStartedQuestStatus = "todo" | "inReview" | "done";
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

/** These actions can be saved before their financial confirmation arrives. */
const PENDING_QUEST_KEYS: ReadonlySet<GetStartedQuestKey> = new Set([
  "workflow",
  "checkin",
]);

const reloadVersion$ = state(0);
const getStartedStatus$ = computed(
  async (get): Promise<GetStartedStatus | null> => {
    get(reloadVersion$);
    await get(authenticatedIdentity$);
    const response = await accept(
      get(apiClient$)(getStartedContract).status(),
      [200, 403, 404],
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
const menuOpenPageVersion$ = state<number | null>(null);
const resetCheckinFeedback$ = resetSignal();
const menuTriggerElement$ = state<HTMLButtonElement | null>(null);
export const setGetStartedMenuTrigger$ = onRef(
  command(({ set }, element: HTMLButtonElement, signal: AbortSignal) => {
    set(menuTriggerElement$, element);
    signal.addEventListener("abort", () => {
      set(menuTriggerElement$, null);
    });
  }),
);
// The pending row unmounts on success; return focus to its persistent entry.
export const checkinConfirmationFinalFocus$ = command(({ get }) => {
  return get(menuTriggerElement$) ?? true;
});
export const getStartedMenuOpen$ = computed((get) => {
  return get(menuOpenPageVersion$) === get(pageVersion$);
});
export const setGetStartedMenuOpen$ = command(({ get, set }, open: boolean) => {
  // An old check-in must not interrupt a menu the user dismissed or reopened.
  set(resetCheckinFeedback$);
  set(menuOpenPageVersion$, open ? get(pageVersion$) : null);
  if (open) {
    set(reloadSlackOrg$);
    set(reloadGetStarted$);
  }
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
      // A reviewed quest that has a claim in flight is waiting, not untouched.
      // Without this the workflow row kept offering its own action for as long
      // as the hourly worker took to reach the claim the user had just earned.
      if (
        status === "todo" &&
        PENDING_QUEST_KEYS.has(quest.key) &&
        quest.pendingCount > 0
      ) {
        status = "inReview";
      }
      return { ...quest, status };
    });
    const slack = quests.find((quest) => {
      return quest.key === "slack";
    });
    // Only a quest that can still be earned depends on the install. A failed
    // Slack read leaves the quest as the API reported it instead of taking the
    // whole list down; the Slack surfaces own reporting that failure.
    const slackOrg = slack?.canEarnMore
      ? // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
        await settle(get(slackOrgData$))
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
 * explains a quest cannot live in the panel's own tree and is held here.
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
const resetConnectorQuestSubscription$ = resetSignal();
export const setQuestIntroKey$ = command(
  ({ get, set }, key: GetStartedQuestKey | null) => {
    if (key === "connector" && get(internalQuestIntroKey$) !== "connector") {
      const signal = set(resetConnectorQuestSubscription$, get(pageSignal$));
      set(subscribeBuiltinConnectorChanges$, signal);
    } else if (key !== "connector") {
      set(resetConnectorQuestSubscription$);
    }
    set(internalQuestIntroKey$, key);
    if (key !== null) {
      set(internalQuestIntroLastKey$, key);
    }
  },
);

const checkinConfirmationState$ = state<{
  readonly claim: GetStartedClaim;
  readonly pageVersion: number;
  readonly open: boolean;
} | null>(null);
export const checkinConfirmation$ = computed((get) => {
  const confirmation = get(checkinConfirmationState$);
  return (
    confirmation && {
      claim: confirmation.claim,
      open: confirmation.open && confirmation.pageVersion === get(pageVersion$),
    }
  );
});
export const closeCheckinConfirmation$ = command(({ get, set }) => {
  const confirmation = get(checkinConfirmationState$);
  if (confirmation) {
    set(checkinConfirmationState$, { ...confirmation, open: false });
  }
});

const checkinRequestState$ = state<Promise<void> | null>(null);
export const checkinRequest$ = computed((get) => {
  return get(checkinRequestState$);
});

const claimGetStartedCheckin$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const feedbackSignal = set(resetCheckinFeedback$, signal);
    const result = await accept(
      get(apiClient$)(getStartedContract).checkin({
        fetchOptions: { signal },
      }),
      [200, 202],
      signal,
    );
    signal.throwIfAborted();
    const granted = result.status === 200 && result.body.status === "granted";
    if (granted && !feedbackSignal.aborted) {
      set(setGetStartedMenuOpen$, false);
      set(checkinConfirmationState$, {
        claim: result.body,
        pageVersion: get(pageVersion$),
        open: true,
      });
    }
    // The financial receipt confirms success. Refreshing the list must not
    // delay or erase it, even if another service is slow or unavailable.
    set(reloadGetStarted$);
    await Promise.all([
      granted ? undefined : get(getStartedStatus$),
      set(reloadAccountMenuCreditBalances$, signal),
    ]);
    signal.throwIfAborted();
  },
);

export const checkInGetStarted$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const request = set(claimGetStartedCheckin$, signal);
    set(checkinRequestState$, request);
    await request;
  },
);

const refreshGetStartedFromRealtime$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    set(reloadGetStarted$);
    const data = await get(getStartedStatus$);
    signal.throwIfAborted();
    if (!data) {
      return true;
    }
    await set(reloadAccountMenuCreditBalances$, signal);
    signal.throwIfAborted();
    return false;
  },
);

const refreshGetStartedFromSlack$ = command(
  ({ set }, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    set(reloadSlackOrg$);
    return set(refreshGetStartedFromRealtime$, signal);
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
    set(
      setAblyLoop$,
      {
        topic: "slack:changed",
        loopCommand$: refreshGetStartedFromSlack$,
      },
      signal,
    );
  },
);
