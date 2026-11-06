import { command } from "ccstate";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { refreshChatListLayout$ } from "../chat-page/chat-list-layout.ts";
import {
  resetFeatureSwitches$,
  setFeatureSwitch$,
} from "../external/feature-switch.ts";

// Switches add sidebar entries and change the chat list's frame, so applying
// them can change the chat list's available height.

export const setLabFeatureSwitch$ = command(
  async (
    { set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    await set(setFeatureSwitch$, overrides, signal);
    signal.throwIfAborted();
    await set(refreshChatListLayout$, signal);
  },
);

export const resetLabFeatureSwitches$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(resetFeatureSwitches$, signal);
    signal.throwIfAborted();
    await set(refreshChatListLayout$, signal);
  },
);
