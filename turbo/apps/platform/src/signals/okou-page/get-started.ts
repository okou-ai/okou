import { command, computed, state } from "ccstate";
import {
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedClaim,
  type GetStartedQuestKey,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "../api-client.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { accept } from "../../lib/accept.ts";
import {
  detach,
  isRecord,
  jsonParseOr,
  Reason,
  resetSignal,
  settle,
  waitForOperation,
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

const {
  get$: getStartedRewardNoticeIdsRaw$,
  set$: setGetStartedRewardNoticeIdsRaw$,
} = localStorageSignals("get-started-reward-notice-ids");
const MAX_STORED_GET_STARTED_ACCOUNTS = 12;
const MAX_STORED_GET_STARTED_REWARDS = 20;

interface GetStartedRewardQueue {
  readonly identityKey: string | null;
  readonly claims: readonly GetStartedRewardNotice[];
}

interface GetStartedRewardNotice {
  readonly claim: GetStartedClaim;
  /** The streak at the time of a direct check-in, when the client knows it. */
  readonly checkinStreak: number | null;
}

const internalGetStartedRewardQueue$ = state<GetStartedRewardQueue>({
  identityKey: null,
  claims: [],
});
export const pendingGetStartedReward$ = computed((get) => {
  return get(internalGetStartedRewardQueue$).claims[0] ?? null;
});

function storedGetStartedRewardIds(
  raw: string | null,
): Record<string, string[]> {
  if (raw === null) {
    return {};
  }
  const parsed = jsonParseOr<unknown>(raw, {});
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return {};
  }
  const entries: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      Array.isArray(value) &&
      value.every((id): id is string => {
        return typeof id === "string";
      })
    ) {
      entries[key] = value.slice(-MAX_STORED_GET_STARTED_REWARDS);
    }
  }
  return entries;
}

function serializeGetStartedRewardIds(
  stored: Record<string, string[]>,
  identityKey: string,
  ids: readonly string[],
): string {
  const accounts = Object.entries(stored).filter(([key]) => {
    return key !== identityKey;
  });
  const next = [
    ...accounts.slice(-(MAX_STORED_GET_STARTED_ACCOUNTS - 1)),
    [identityKey, [...new Set(ids)].slice(-MAX_STORED_GET_STARTED_REWARDS)],
  ];
  return JSON.stringify(Object.fromEntries(next));
}

const reconcileGetStartedRewardNotices$ = command(
  async (
    { get, set },
    status: GetStartedStatus,
    signal: AbortSignal,
  ): Promise<readonly GetStartedClaim[]> => {
    const identity = await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
    const identityKey = JSON.stringify([identity.orgId, identity.userId]);
    const stored = storedGetStartedRewardIds(
      get(getStartedRewardNoticeIdsRaw$),
    );
    const granted = status.recentGrants
      .filter((claim) => {
        return claim.status === "granted";
      })
      .reverse();
    const previouslySeen = stored[identityKey];
    if (!previouslySeen) {
      // The first snapshot is the baseline. Past rewards must not all open a
      // dialog the first time this version reaches an existing workspace.
      set(
        setGetStartedRewardNoticeIdsRaw$,
        serializeGetStartedRewardIds(
          stored,
          identityKey,
          granted.map((claim) => {
            return claim.id;
          }),
        ),
      );
      set(internalGetStartedRewardQueue$, (queue) => {
        return queue.identityKey === identityKey
          ? queue
          : { identityKey, claims: [] };
      });
      return [];
    }

    const seen = new Set(previouslySeen);
    const queue = get(internalGetStartedRewardQueue$);
    const currentClaims = queue.identityKey === identityKey ? queue.claims : [];
    const queuedIds = new Set(
      currentClaims.map((notice) => {
        return notice.claim.id;
      }),
    );
    const newlyGranted = granted.filter((claim) => {
      return !seen.has(claim.id) && !queuedIds.has(claim.id);
    });
    set(internalGetStartedRewardQueue$, {
      identityKey,
      claims: [
        ...currentClaims,
        ...newlyGranted.map((claim) => {
          return {
            claim,
            checkinStreak:
              claim.questKey === "checkin" ? status.checkinStreak : null,
          };
        }),
      ],
    });
    return newlyGranted;
  },
);

/** The check-in response is authoritative, even if it races the first snapshot. */
const queueGetStartedReward$ = command(
  async (
    { get, set },
    claim: GetStartedClaim,
    checkinStreak: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (claim.status !== "granted" || claim.questKey !== "checkin") {
      return;
    }
    const identity = await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
    const identityKey = JSON.stringify([identity.orgId, identity.userId]);
    const queue = get(internalGetStartedRewardQueue$);
    const currentClaims = queue.identityKey === identityKey ? queue.claims : [];
    const currentNotice = currentClaims.find((notice) => {
      return notice.claim.id === claim.id;
    });
    if (currentNotice) {
      set(internalGetStartedRewardQueue$, {
        identityKey,
        claims: currentClaims.map((notice) => {
          return notice.claim.id === claim.id
            ? { ...notice, checkinStreak }
            : notice;
        }),
      });
      return;
    }
    const seenIds = storedGetStartedRewardIds(
      get(getStartedRewardNoticeIdsRaw$),
    )[identityKey];
    if (seenIds?.includes(claim.id)) {
      return;
    }
    set(internalGetStartedRewardQueue$, {
      identityKey,
      claims: [...currentClaims, { claim, checkinStreak }],
    });
  },
);

export const refreshGetStartedRewardStatus$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<{
    readonly status: GetStartedStatus | null;
    readonly newlyGranted: readonly GetStartedClaim[];
  }> => {
    set(reloadGetStarted$);
    const status = await waitForOperation(get(getStartedStatus$), signal);
    signal.throwIfAborted();
    if (!status) {
      return { status: null, newlyGranted: [] };
    }
    const newlyGranted = await set(
      reconcileGetStartedRewardNotices$,
      status,
      signal,
    );
    if (newlyGranted.length > 0) {
      detach(
        set(reloadAccountMenuCreditBalances$, signal),
        Reason.Daemon,
        "reload get started credit balances",
      );
    }
    return { status, newlyGranted };
  },
);

export const dismissGetStartedReward$ = command(
  ({ get, set }, claimId: string) => {
    const queue = get(internalGetStartedRewardQueue$);
    const claim = queue.claims.find((candidate) => {
      return candidate.claim.id === claimId;
    });
    if (!claim || !queue.identityKey) {
      return;
    }

    const stored = storedGetStartedRewardIds(
      get(getStartedRewardNoticeIdsRaw$),
    );
    set(
      setGetStartedRewardNoticeIdsRaw$,
      serializeGetStartedRewardIds(stored, queue.identityKey, [
        ...(stored[queue.identityKey] ?? []),
        claim.claim.id,
      ]),
    );
    set(internalGetStartedRewardQueue$, {
      identityKey: queue.identityKey,
      claims: queue.claims.filter((candidate) => {
        return candidate.claim.id !== claim.claim.id;
      }),
    });
  },
);

/**
 * The latest share claim, which carries what the row cannot: which post is in
 * the queue and when it went in.
 */
export const shareClaim$ = computed(async (get) => {
  const data = await get(getStartedStatus$);
  return data?.shareClaim ?? null;
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
  },
);
export interface GetStartedSummary {
  readonly completed: number;
  readonly total: number;
  readonly earnedCredits: number;
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
      earnedCredits: quests
        .filter((quest) => {
          return quest.rewardTarget === "user";
        })
        .reduce((sum, quest) => {
          return sum + quest.earnedCredits;
        }, 0),
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
export const setQuestIntroKey$ = command(
  ({ set }, key: GetStartedQuestKey | null) => {
    set(internalQuestIntroKey$, key);
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

export const checkInGetStarted$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<number> => {
    const previousStreak = (await get(getStartedSummary$)).checkinStreak;
    const { body: claim } = await accept(
      get(apiClient$)(getStartedContract).checkin({
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    const optimisticStreak = previousStreak + 1;
    await set(queueGetStartedReward$, claim, optimisticStreak, signal);
    signal.throwIfAborted();
    const refresh = await settle(
      set(refreshGetStartedRewardStatus$, signal),
      signal,
    );
    signal.throwIfAborted();
    const checkinStreak = refresh.ok
      ? (refresh.value.status?.checkinStreak ?? optimisticStreak)
      : optimisticStreak;
    await set(queueGetStartedReward$, claim, checkinStreak, signal);
    signal.throwIfAborted();
    if (!refresh.ok || refresh.value.newlyGranted.length === 0) {
      detach(
        set(reloadAccountMenuCreditBalances$, signal),
        Reason.DomCallback,
        "reload get started credit balances",
      );
    }
    return checkinStreak;
  },
);

const refreshGetStartedFromRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const { status } = await set(refreshGetStartedRewardStatus$, signal);
    signal.throwIfAborted();
    if (!status) {
      return true;
    }
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
        for (const topic of [
          GET_STARTED_REWARDS_CHANGED_EVENT,
          "connector:changed",
          "customConnectorListChanged",
          "slack:changed",
        ]) {
          set(
            setAblyLoop$,
            {
              topic,
              loopCommand$: refreshGetStartedFromRealtime$,
              options: {
                runOnSubscribe: topic === GET_STARTED_REWARDS_CHANGED_EVENT,
              },
            },
            ownerSignal,
          );
        }
      })(signal),
      Reason.Daemon,
      "get started",
    );
  },
);
