import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";

const internalChatThreadOnlyMuted$ = state(false);

export const chatThreadOnlyMuted$ = computed((get) => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.ChatThreadMuting] === true &&
    get(internalChatThreadOnlyMuted$)
  );
});

export const setChatThreadOnlyMuted$ = command(
  ({ set }, onlyMuted: boolean) => {
    set(internalChatThreadOnlyMuted$, onlyMuted);
  },
);
