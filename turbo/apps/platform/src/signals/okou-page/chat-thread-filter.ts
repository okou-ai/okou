import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";

export type ChatThreadFilter =
  "unarchived" | "withArchived" | "unread" | "muted";
const selectedFilter$ = state<ChatThreadFilter>("unarchived");

export const chatThreadFilter$ = computed((get) => {
  return get(selectedFilter$);
});
export const setChatThreadFilter$ = command(
  ({ set }, filter: ChatThreadFilter) => {
    set(selectedFilter$, filter);
  },
);

// The same menu entry opens Archived or All according to the current workspace.
export const archiveListFilter$ = computed(
  async (get): Promise<"all" | "archived"> => {
    // Keep the existing Archived filter usable if the rollout configuration is unavailable.
    const [features] = await Promise.allSettled([get(featureSwitches$)]);
    return features.status === "fulfilled" &&
      features.value[FeatureSwitchKey.ChatListAllFilter]
      ? "all"
      : "archived";
  },
);

export const activeChatThreadFilter$ = computed(async (get) => {
  const filter = get(chatThreadFilter$);
  return filter === "withArchived" ? await get(archiveListFilter$) : filter;
});
