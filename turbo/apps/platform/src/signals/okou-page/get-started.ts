import { command, computed, state } from "ccstate";
import { isOrgAdmin$ } from "../org.ts";

/** The onboarding quests, named the way the panel lists them. */
export type GetStartedQuestKey =
  | "connector"
  | "slack"
  | "workflow"
  | "invite"
  | "share"
  | "checkin";

/**
 * `inReview` belongs to the X post alone: it is the only quest a person claims
 * by submitting something, so it has a state between untouched and earned.
 */
export type GetStartedQuestStatus = "todo" | "inReview" | "done";

export interface GetStartedQuest {
  readonly key: GetStartedQuestKey;
  readonly status: GetStartedQuestStatus;
  /** Credits this person has already earned from this quest. */
  readonly earnedCredits: number;
}

/**
 * Installing Slack and inviting members are org-level actions, so a member is
 * offered only the quests they can finish on their own. Both the count and the
 * ring are computed from whichever set applies, never from the admin set, so a
 * member is never shown a step they cannot take or a total they cannot reach.
 */
const ADMIN_QUEST_KEYS = [
  "connector",
  "slack",
  "workflow",
  "invite",
  "share",
  "checkin",
] as const satisfies readonly GetStartedQuestKey[];

const MEMBER_QUEST_KEYS = [
  "connector",
  "workflow",
  "share",
  "checkin",
] as const satisfies readonly GetStartedQuestKey[];

/**
 * Placeholder progress.
 *
 * Credits are earned per person rather than per org, so this stands in for a
 * per-user endpoint that does not exist yet. Nothing here reads or writes a
 * real balance, which is why the whole entry stays behind its feature switch.
 */
const mockQuestProgress$ = state<
  Readonly<Record<GetStartedQuestKey, GetStartedQuest>>
>({
  connector: { key: "connector", status: "done", earnedCredits: 300 },
  slack: { key: "slack", status: "done", earnedCredits: 2000 },
  workflow: { key: "workflow", status: "todo", earnedCredits: 0 },
  invite: { key: "invite", status: "todo", earnedCredits: 0 },
  share: { key: "share", status: "todo", earnedCredits: 0 },
  checkin: { key: "checkin", status: "todo", earnedCredits: 0 },
});

export const getStartedQuests$ = computed(
  async (get): Promise<readonly GetStartedQuest[]> => {
    const isAdmin = await get(isOrgAdmin$);
    const progress = get(mockQuestProgress$);
    const keys = isAdmin ? ADMIN_QUEST_KEYS : MEMBER_QUEST_KEYS;
    return keys.map((key) => {
      return progress[key];
    });
  },
);

export interface GetStartedSummary {
  readonly completed: number;
  readonly total: number;
  /** Credits this person has earned, not the org balance. */
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
      earnedCredits: quests.reduce((sum, quest) => {
        return sum + quest.earnedCredits;
      }, 0),
    };
  },
);

const internalShareDialogOpen$ = state(false);
const internalSharePostDraft$ = state("");

export const shareDialogOpen$ = computed((get) => {
  return get(internalShareDialogOpen$);
});

export const sharePostDraft$ = computed((get) => {
  return get(internalSharePostDraft$);
});

/** Closing always clears the field, so reopening never shows a stale link. */
export const setShareDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalShareDialogOpen$, open);
  if (!open) {
    set(internalSharePostDraft$, "");
  }
});

export const setSharePostDraft$ = command(({ set }, draft: string) => {
  set(internalSharePostDraft$, draft);
});

/**
 * Spend the single X submission.
 *
 * The post URL is deliberately not carried anywhere yet: no endpoint accepts
 * it, and keeping it in the client would only pretend it had been stored. The
 * real command takes the URL and returns the review outcome.
 */
export const submitSharePost$ = command(({ set }) => {
  set(mockQuestProgress$, (progress) => {
    const share: GetStartedQuest = { ...progress.share, status: "inReview" };
    return { ...progress, share };
  });
  set(internalShareDialogOpen$, false);
  set(internalSharePostDraft$, "");
});
